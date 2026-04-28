// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { makeIntegrationHarness, type IntegrationHarness } from './_integration-setup';

describe('Phase 7: text-flow overlap round-trip', () => {
  let h: IntegrationHarness | null = null;

  afterEach(() => {
    h?.destroy();
    h = null;
  });

  it('7.2: two overlapping text-level comments produce two distinct blocks in Copy all', async () => {
    h = makeIntegrationHarness('<p>The quick brown fox jumps</p>');
    h.llmToggle.workspaceRelativePath = 'docs/demo.md';
    h.llmToggle.toggle();

    // Apply mark A to "quick brown" (ProseMirror positions 5-16 — see the
    // llmCommentMark spike test for the same positions on the same string).
    h.editor
      .chain()
      .focus()
      .setTextSelection({ from: 5, to: 16 })
      .setLlmComment({ commentId: 'A' })
      .run();
    h.llmStore.add({
      id: 'A',
      kind: 'text',
      body: 'rewrite A',
      createdAt: 100,
      startLine: 1,
      endLine: 1,
    });

    // Apply mark B to "brown fox" (positions 11-20) — overlaps A at "brown".
    h.editor
      .chain()
      .focus()
      .setTextSelection({ from: 11, to: 20 })
      .setLlmComment({ commentId: 'B' })
      .run();
    h.llmStore.add({
      id: 'B',
      kind: 'text',
      body: 'rewrite B',
      createdAt: 200,
      startLine: 1,
      endLine: 1,
    });

    // Both marks should be present in the doc.
    const idsInDoc = new Set<string>();
    h.editor.state.doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === 'llmComment') {
          const id = (mark.attrs as { commentId?: string }).commentId;
          if (id) idsInDoc.add(id);
        }
      }
      return true;
    });
    expect(idsInDoc.has('A')).toBe(true);
    expect(idsInDoc.has('B')).toBe(true);

    // Copy all.
    const copyBtn = document.querySelector('.llm-copy-all') as HTMLButtonElement;
    copyBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.clipboardSpy).toHaveBeenCalledTimes(1);
    const payload = h.clipboardSpy.mock.calls[0][0] as string;

    // Two blocks → labelled "Comment 1 — " / "Comment 2 — " with "Feedback-1:" / "Feedback-2:".
    expect(payload).toContain('Comment 1 — ');
    expect(payload).toContain('Comment 2 — ');
    expect(payload).toContain('Feedback-1:');
    expect(payload).toContain('Feedback-2:');

    // Bodies appear in deterministic order (A createdAt 100 before B createdAt 200).
    const idxA = payload.indexOf('rewrite A');
    const idxB = payload.indexOf('rewrite B');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);

    // Two blocks are separated by the "---" divider.
    expect(payload).toContain('\n\n---\n\n');

    // P8 — live quoted text per block. The store's fallback walk collects the
    // text content of all nodes carrying a given mark id. With overlapping
    // marks, both ids should resolve to non-empty quoted text in each block.
    // The per-block quoted text contains the range each mark covers:
    //   block A → contains "quick" (covered only by A at positions 5-10)
    //   block B → contains "fox"   (covered only by B at positions 17-20)
    // We assert both "quick" and "fox" appear somewhere in the payload as a
    // proxy for each block carrying its own live quote. This is weaker than
    // asserting per-block placement, but strong enough to detect a regression
    // where the quoted-text lookup returns the same value for both blocks.
    expect(payload).toContain('quick');
    expect(payload).toContain('fox');
  });
});
