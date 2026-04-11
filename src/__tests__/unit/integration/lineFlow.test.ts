// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { makeIntegrationHarness, type IntegrationHarness } from './_integration-setup';

describe('Phase 7: line-flow round-trip', () => {
  let h: IntegrationHarness | null = null;

  afterEach(() => {
    h?.destroy();
    h = null;
  });

  it('7.1: openLlmLine → Save → Copy all produces the LLD payload', async () => {
    h = makeIntegrationHarness(
      '<h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p>',
    );
    h.llmToggle.workspaceRelativePath = 'docs/demo.md';
    h.llmToggle.toggle(); // activate

    // Open the LLM line panel for line 3 (the "First paragraph." block in
    // the rendered markdown: line 1 = "# Title", line 2 = blank, line 3 = text).
    // The panel's openLlmLine takes an anchor element and a 1-indexed line.
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
    h.editorElement.appendChild(anchor);

    h.commentPanel.openLlmLine(3, anchor);

    // Type into the panel textarea.
    const ta = document.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();
    ta!.value = 'expand this';

    // Click Save.
    const saveBtn = document.querySelector('.comment-reply-queue') as HTMLButtonElement | null;
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.textContent).toBe('Save');
    saveBtn!.click();

    // Store now holds a single line-level comment tied to line 3.
    expect(h.llmStore.getCount()).toBe(1);
    const entry = h.llmStore.getAll()[0];
    expect(entry.kind).toBe('line');
    expect(entry.body).toBe('expand this');
    expect(entry.startLine).toBe(3);
    expect(entry.endLine).toBe(3);

    // Click Copy all.
    const copyBtn = document.querySelector('.llm-copy-all') as HTMLButtonElement | null;
    expect(copyBtn).toBeTruthy();
    copyBtn!.click();

    // Drain microtasks + the async clipboard write.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.clipboardSpy).toHaveBeenCalledTimes(1);
    const payload = h.clipboardSpy.mock.calls[0][0] as string;

    // Structural assertions — the LLD payload format.
    expect(payload.startsWith('File: docs/demo.md')).toBe(true);
    expect(payload).toContain('Line 3 — Selected text:');
    expect(payload).toContain('Comment:');
    expect(payload).toContain('expand this');
    // Triple-quote fences must wrap both the selected-text and body blocks.
    const fenceCount = (payload.match(/"""/g) ?? []).length;
    expect(fenceCount).toBeGreaterThanOrEqual(4);
  });
});
