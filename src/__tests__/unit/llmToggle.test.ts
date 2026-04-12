// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tiptap/core', () => ({
  Editor: class {},
}));

import { LlmToggle } from '../../webview/llmToggle';
import { LlmCommentStore, type LlmComment } from '../../webview/llmCommentStore';

// ---------- test helpers ----------

function makeMockEditor() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    commands: {
      clearAllLlmComments: vi.fn(() => true),
    },
    state: { doc: {} },
    storage: {
      llmLineMap: { getTextForLine: (_n: number) => 'line text' },
    },
  } as any;
}

function makeMockCommentToggle(active = false) {
  return {
    isActive: vi.fn(() => active),
  } as any;
}

function makeMockPanel() {
  return {} as any;
}

function makeMockSelectionAnchor() {
  return {
    setActive: vi.fn(),
    isActive: vi.fn(() => false),
  } as any;
}

function makeVsCode() {
  return { postMessage: vi.fn() };
}

function makeComment(overrides: Partial<LlmComment> = {}): LlmComment {
  return {
    id: 'c1',
    kind: 'line',
    body: 'example body',
    createdAt: 1,
    startLine: 1,
    endLine: 1,
    ...overrides,
  };
}

interface Harness {
  toggle: LlmToggle;
  store: LlmCommentStore;
  editor: ReturnType<typeof makeMockEditor>;
  vscode: ReturnType<typeof makeVsCode>;
  panel: ReturnType<typeof makeMockPanel>;
  commentToggle: ReturnType<typeof makeMockCommentToggle>;
  selectionAnchor: ReturnType<typeof makeMockSelectionAnchor>;
  updateIndicator: ReturnType<typeof vi.fn>;
  rebuildLineMap: ReturnType<typeof vi.fn>;
}

function build(opts: { reviewActive?: boolean } = {}): Harness {
  const store = new LlmCommentStore();
  const editor = makeMockEditor();
  const vscode = makeVsCode();
  const panel = makeMockPanel();
  const commentToggle = makeMockCommentToggle(opts.reviewActive ?? false);
  const selectionAnchor = makeMockSelectionAnchor();
  const updateIndicator = vi.fn();
  const rebuildLineMap = vi.fn();

  const toggle = new LlmToggle(
    editor,
    vscode,
    store,
    panel,
    commentToggle,
    selectionAnchor,
    updateIndicator,
    rebuildLineMap,
  );

  return {
    toggle,
    store,
    editor,
    vscode,
    panel,
    commentToggle,
    selectionAnchor,
    updateIndicator,
    rebuildLineMap,
  };
}

function queryBar(): HTMLDivElement {
  return document.querySelector('.llm-bar') as HTMLDivElement;
}
function queryToggleBtn(): HTMLButtonElement {
  return document.querySelector('.llm-toggle') as HTMLButtonElement;
}
function queryCopyAllBtn(): HTMLButtonElement {
  return document.querySelector('.llm-copy-all') as HTMLButtonElement;
}
function queryClearAllBtn(): HTMLButtonElement {
  return document.querySelector('.llm-clear-all') as HTMLButtonElement;
}
function queryErrorBanner(): HTMLDivElement {
  return document.querySelector('.llm-error-banner') as HTMLDivElement;
}

// ---------- lifecycle ----------

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// ---------- tests ----------

describe('LlmToggle', () => {
  it('T1: initial state — "LLM-Assist: Off" and bar hidden', () => {
    build();
    expect(queryToggleBtn().textContent).toBe('LLM-Assist: Off');
    expect(queryBar().style.display).toBe('none');
  });

  it('T2: rejects activation when Review mode is active', () => {
    const h = build({ reviewActive: true });
    h.toggle.toggle();

    const banner = queryErrorBanner();
    expect(banner).not.toBeNull();
    expect(banner.textContent).toBe('Review mode is active — toggle it off first');
    expect(banner.style.display).not.toBe('none');
    expect(queryToggleBtn().textContent).toBe('LLM-Assist: Off');

    const activateCall = h.updateIndicator.mock.calls.find(
      (c: unknown[]) => (c[0] as { llmAssistActive?: boolean }).llmAssistActive === true,
    );
    expect(activateCall).toBeUndefined();
  });

  it('T3: activate path wires everything up', () => {
    const h = build();
    h.toggle.toggle();

    expect(h.rebuildLineMap).toHaveBeenCalled();
    expect(h.updateIndicator).toHaveBeenCalledWith({
      llmAssistActive: true,
      llmComments: [],
    });
    expect(h.editor.on).toHaveBeenCalledWith('update', expect.any(Function));
    expect(queryToggleBtn().textContent).toBe('LLM-Assist: On');
    expect(h.selectionAnchor.setActive).toHaveBeenCalledWith(true);
  });

  it('T4: action row stays hidden after activation with an empty store', () => {
    const h = build();
    h.toggle.toggle();
    expect(queryBar().style.display).toBe('none');
  });

  it('T5: first add shows row with "Copy all (1)" / "Clear all (1)"', () => {
    const h = build();
    h.toggle.toggle();

    h.store.add(makeComment({ id: 'a', body: 'x' }));

    expect(queryBar().style.display).toBe('flex');
    expect(queryCopyAllBtn().textContent).toBe('Copy all (1)');
    expect(queryClearAllBtn().textContent).toBe('Clear all (1)');
  });

  it('T6: reactive label reflects count — 3 → 2 after a remove', () => {
    const h = build();
    h.toggle.toggle();

    h.store.add(makeComment({ id: 'a' }));
    h.store.add(makeComment({ id: 'b' }));
    h.store.add(makeComment({ id: 'c' }));
    expect(queryCopyAllBtn().textContent).toBe('Copy all (3)');

    h.store.remove('b');
    expect(queryCopyAllBtn().textContent).toBe('Copy all (2)');
    expect(queryClearAllBtn().textContent).toBe('Clear all (2)');
  });

  it('T7: copy success — writeText called, label flashes "Copied ✓" then reverts', async () => {
    const h = build();
    h.toggle.workspaceRelativePath = 'docs/demo.md';
    h.toggle.toggle();

    h.store.add(makeComment({ id: 'a', body: 'hello world' }));

    const writeText = (navigator.clipboard.writeText as unknown) as ReturnType<typeof vi.fn>;
    writeText.mockClear();
    writeText.mockResolvedValue(undefined);

    // Use real timers but small delay for reliability.
    queryCopyAllBtn().click();

    // Drain microtasks so the awaited writeText and the label flip run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const arg = writeText.mock.calls[0][0] as string;
    expect(arg).toContain('File: `docs/demo.md`');
    expect(arg).toContain('hello world');
    expect(queryCopyAllBtn().textContent).toBe('Copied ✓');

    // Wait for the 1500ms timer to expire and restore the reactive label.
    await new Promise(r => setTimeout(r, 1600));
    expect(queryCopyAllBtn().textContent).toBe('Copy all (1)');
  }, 10000);

  it('T8: copy failure — label flashes "Copy failed", reverts after 3000ms, console.warn once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const h = build();
    h.toggle.toggle();
    h.store.add(makeComment({ id: 'a' }));

    const writeText = (navigator.clipboard.writeText as unknown) as ReturnType<typeof vi.fn>;
    writeText.mockClear();
    writeText.mockRejectedValueOnce(new Error('denied'));

    queryCopyAllBtn().click();

    // Drain microtasks so the rejected promise's catch path runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queryCopyAllBtn().textContent).toBe('Copy failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await new Promise(r => setTimeout(r, 3100));
    expect(queryCopyAllBtn().textContent).toBe('Copy all (1)');

    warnSpy.mockRestore();
  }, 10000);

  it('T9: copy with empty store — writeText not called, no flash', async () => {
    const h = build();
    h.toggle.toggle();

    const writeText = (navigator.clipboard.writeText as unknown) as ReturnType<typeof vi.fn>;
    writeText.mockClear();

    // Click the button directly regardless of bar visibility.
    queryCopyAllBtn().click();

    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
    expect(queryCopyAllBtn().textContent).toBe('Copy all (0)');
  });

  it('T10: clearAll clears the store and fires the editor command once', () => {
    const h = build();
    h.toggle.toggle();

    h.store.add(makeComment({ id: 'a' }));
    h.store.add(makeComment({ id: 'b' }));
    expect(h.store.getCount()).toBe(2);

    queryClearAllBtn().click();

    expect(h.store.getCount()).toBe(0);
    expect(h.editor.commands.clearAllLlmComments).toHaveBeenCalledTimes(1);
  });

  it('T11: deactivate path tears everything down', () => {
    const h = build();
    h.toggle.toggle();
    h.store.add(makeComment({ id: 'a' }));

    // sanity — we're now active
    expect(queryToggleBtn().textContent).toBe('LLM-Assist: On');

    // Clear prior call history so we only see the deactivate-time call.
    h.updateIndicator.mockClear();

    h.toggle.toggle();

    expect(h.store.getCount()).toBe(0);
    expect(h.editor.commands.clearAllLlmComments).toHaveBeenCalled();
    expect(h.updateIndicator).toHaveBeenCalledWith({
      llmAssistActive: false,
      llmComments: [],
    });
    expect(h.editor.off).toHaveBeenCalledWith('update', expect.any(Function));
    expect(queryToggleBtn().textContent).toBe('LLM-Assist: Off');
    expect(queryBar().style.display).toBe('none');
    expect(h.selectionAnchor.setActive).toHaveBeenLastCalledWith(false);
  });

  it('T12: toggle() is exposed as a public method for external (message-routed) callers', () => {
    const h = build();
    expect(typeof h.toggle.toggle).toBe('function');
    expect(typeof h.toggle.isActive).toBe('function');
    expect(h.toggle.isActive()).toBe(false);
    h.toggle.toggle();
    expect(h.toggle.isActive()).toBe(true);
  });
});
