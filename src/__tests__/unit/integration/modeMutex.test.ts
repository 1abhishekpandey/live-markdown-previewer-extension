// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { makeIntegrationHarness, type IntegrationHarness } from './_integration-setup';

describe('Phase 7: mode mutex round-trip', () => {
  let h: IntegrationHarness | null = null;

  afterEach(() => {
    h?.destroy();
    h = null;
  });

  it('7.3: LLM toggle is rejected while review mode is active, then accepted after review deactivates', () => {
    h = makeIntegrationHarness('<p>hello</p>');

    // Step 1 — review mode on. The commentToggle stub reports active.
    h.commentToggleMock.isActive.mockReturnValue(true);

    h.llmToggle.toggle();
    expect(h.llmToggle.isActive()).toBe(false);

    const banner = document.querySelector('.llm-error-banner') as HTMLDivElement | null;
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('Review mode is active');
    expect(banner!.style.display).not.toBe('none');

    // Toggle button label should still say "Off".
    const toggleBtn = document.querySelector('.llm-toggle') as HTMLButtonElement;
    expect(toggleBtn.textContent).toBe('Assist: Off');

    // Step 2 — review mode off. Flip the stub, retry, expect activation.
    h.commentToggleMock.isActive.mockReturnValue(false);

    h.llmToggle.toggle();
    expect(h.llmToggle.isActive()).toBe(true);
    expect(toggleBtn.textContent).toBe('Assist: On');
  });
});
