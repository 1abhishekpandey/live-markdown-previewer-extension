// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { makeIntegrationHarness, type IntegrationHarness } from './_integration-setup';

describe('Phase 7: toggle-off wipe round-trip', () => {
  let h: IntegrationHarness | null = null;

  afterEach(() => {
    h?.destroy();
    h = null;
  });

  it('7.4: deactivate clears both the store and the llmComment marks', () => {
    h = makeIntegrationHarness('<p>The quick brown fox jumps</p>');
    h.llmToggle.toggle(); // activate

    // Add one line-level comment directly via the store.
    h.llmStore.add({
      id: 'L1',
      kind: 'line',
      body: 'line note',
      createdAt: 1,
      startLine: 1,
      endLine: 1,
    });

    // Apply one text-level mark to "quick brown" (positions 5-16 on the
    // seeded paragraph) and track it in the store.
    h.editor
      .chain()
      .focus()
      .setTextSelection({ from: 5, to: 16 })
      .setLlmComment({ commentId: 'T1' })
      .run();
    h.llmStore.add({
      id: 'T1',
      kind: 'text',
      body: 'text note',
      createdAt: 2,
      startLine: 1,
      endLine: 1,
    });

    // Confirm the mark is applied in the doc.
    expect(h.editor.getHTML()).toContain('data-llm-comment-id');
    expect(h.llmStore.getCount()).toBe(2);

    // Toggle off.
    h.llmToggle.toggle();

    // Store is fully cleared.
    expect(h.llmStore.getCount()).toBe(0);
    // No data-llm-comment-id survives in the rendered doc.
    expect(h.editor.getHTML()).not.toContain('data-llm-comment-id');

    // Toggle button resets and action row hides.
    const toggleBtn = document.querySelector('.llm-toggle') as HTMLButtonElement;
    expect(toggleBtn.textContent).toBe('Assist: Off');
    const bar = document.querySelector('.llm-bar') as HTMLDivElement;
    expect(bar.style.display).toBe('none');
  });
});
