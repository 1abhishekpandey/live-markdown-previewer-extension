// @vitest-environment happy-dom

vi.mock('@tiptap/core', () => ({
  Editor: class {},
  Extension: { create: vi.fn() },
}));

import { SyncClient } from '../../webview/syncClient';

function makeEditor() {
  const setContent = vi.fn();
  const setEditable = vi.fn();
  const getMarkdown = vi.fn().mockReturnValue('');
  const setTextSelection = vi.fn();
  const chainObj: any = {};
  chainObj.setContent = (...args: any[]) => { setContent(...args); return chainObj; };
  chainObj.command = vi.fn().mockReturnValue(chainObj);
  chainObj.run = vi.fn().mockReturnValue(true);
  return {
    on: vi.fn(),
    chain: vi.fn().mockReturnValue(chainObj),
    commands: {
      setContent,
      focus: vi.fn(),
      setTextSelection,
    },
    setEditable,
    isEditable: true,
    storage: { markdown: { getMarkdown } },
    state: {
      doc: {
        content: { size: 100 },
        forEach: vi.fn(),
        resolve: vi.fn().mockReturnValue({ depth: 0, node: vi.fn().mockReturnValue({ textContent: '' }) }),
      },
      selection: { from: 0, to: 0 },
    },
    view: {
      state: {
        selection: { from: 0, to: 0 },
        doc: {},
        tr: { setMeta: vi.fn().mockReturnThis(), getMeta: vi.fn() },
      },
      posAtCoords: vi.fn(),
      coordsAtPos: vi.fn().mockReturnValue({ top: 0, bottom: 0 }),
      dispatch: vi.fn(),
    },
  };
}

function makeVsCode() {
  return { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
}

describe('handleMessage - init', () => {
  it('sets editor content on init', () => {
    const editor = makeEditor();
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);
    client.handleMessage({ type: 'init', markdown: '# Hello' });
    expect(editor.commands.setContent).toHaveBeenCalledWith('# Hello');
  });

  it('does not set editor uneditable when isReadOnly is false', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    client.handleMessage({ type: 'init', markdown: '# Hello', isReadOnly: false });
    expect(editor.setEditable).not.toHaveBeenCalled();
  });

  it('sets editor uneditable when isReadOnly is true', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    client.handleMessage({ type: 'init', markdown: '# Hello', isReadOnly: true });
    expect(editor.setEditable).toHaveBeenCalledWith(false);
  });

  it('fires onFirstInit callback once on first init then clears it', () => {
    const editor = makeEditor();
    const onFirstInit = vi.fn();
    const client = new SyncClient(editor as any, makeVsCode(), onFirstInit);
    client.handleMessage({ type: 'init', markdown: '# Hello' });
    expect(onFirstInit).toHaveBeenCalledOnce();
    // Second init — callback should NOT fire again (it was cleared)
    client.handleMessage({ type: 'init', markdown: '# World' });
    expect(onFirstInit).toHaveBeenCalledOnce(); // still 1, not 2
  });
});

describe('handleMessage - scrollToAnchor', () => {
  it('buffers scrollToAnchor before init (does not call requestAnimationFrame)', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(_cb => 0);

    // Before init
    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Hello',
      lineIndex: 5,
      totalLines: 100,
      roughFraction: 0.05,
    });

    expect(rafSpy).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it('calls requestAnimationFrame for scrollToAnchor after init', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(_cb => 0);

    // Initialize first
    client.handleMessage({ type: 'init', markdown: '# Hello' });
    // Clear rAF calls from init's pending scroll processing
    rafSpy.mockClear();

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Hello',
      lineIndex: 5,
      totalLines: 100,
      roughFraction: 0.05,
    });

    expect(rafSpy).toHaveBeenCalledOnce();
    rafSpy.mockRestore();
  });

  it('processes buffered scrollToAnchor via rAF after init', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(_cb => 0);

    // Buffer a scroll before init
    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Buffered',
      lineIndex: 10,
      totalLines: 200,
      roughFraction: 0.05,
    });
    expect(rafSpy).not.toHaveBeenCalled();

    // Now init — should process the buffered anchor via rAF
    client.handleMessage({ type: 'init', markdown: '# Hello' });
    expect(rafSpy).toHaveBeenCalledOnce();

    rafSpy.mockRestore();
  });
});

describe('handleMessage - externalUpdate', () => {
  it('drops externalUpdate with version <= currentVersion', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    // currentVersion starts at 0; version 0 <= 0 → drop
    client.handleMessage({ type: 'externalUpdate', markdown: '# Old', version: 0 });
    expect(editor.commands.setContent).not.toHaveBeenCalled();
  });

  it('applies externalUpdate with version > currentVersion', () => {
    const editor = makeEditor();
    // Make getMarkdown return different content so the update is not a no-op
    editor.storage.markdown.getMarkdown.mockReturnValue('# Old');
    const client = new SyncClient(editor as any, makeVsCode());
    client.handleMessage({ type: 'externalUpdate', markdown: '# New', version: 1 });
    expect(editor.commands.setContent).toHaveBeenCalledWith('# New');
  });

  it('does not send edit during applyExternalUpdate (isExternalUpdate echo prevention)', () => {
    vi.useFakeTimers();
    const editor = makeEditor();
    // getMarkdown returns different content so applyExternalUpdate does not short-circuit
    editor.storage.markdown.getMarkdown.mockReturnValue('# Old');
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);
    client.init();

    // Capture the 'update' handler registered by init()
    const updateHandler = (editor.on as any).mock.calls.find((c: any[]) => c[0] === 'update')?.[1];
    expect(updateHandler).toBeDefined();

    // Make setContent synchronously fire the 'update' event — simulating TipTap behaviour
    (editor.commands.setContent as any).mockImplementation(() => {
      updateHandler();
    });

    // Clear call counts from init()'s 'ready' postMessage
    vi.clearAllMocks();

    // Trigger external update: applyExternalUpdate sets isExternalUpdate=true, calls setContent
    // (which fires updateHandler), but the 'update' handler returns early due to isExternalUpdate
    client.handleMessage({ type: 'externalUpdate', markdown: '# New', version: 1 });

    // No edit should be sent — not immediately, and not after timers drain
    vi.runAllTimers();
    expect(vsCode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'edit' }));

    client.dispose();
    vi.useRealTimers();
  });

});

describe('immediate edit dispatch (no debounce)', () => {
  it('update event posts edit message immediately', () => {
    const editor = makeEditor();
    editor.storage.markdown.getMarkdown.mockReturnValue('# Updated');
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);
    client.init();

    // Clear the 'ready' postMessage from init()
    vsCode.postMessage.mockClear();

    // Capture the 'update' handler registered by init()
    const updateHandler = (editor.on as any).mock.calls.find((c: any[]) => c[0] === 'update')?.[1];
    expect(updateHandler).toBeDefined();

    // Trigger an update — should post edit synchronously (no timer needed)
    updateHandler();

    const editCalls = vsCode.postMessage.mock.calls.filter((c: any[]) => c[0].type === 'edit');
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0][0]).toMatchObject({ type: 'edit', markdown: '# Updated', version: 1 });

    client.dispose();
  });

  it('Cmd+Z is not intercepted (no undo message posted)', () => {
    const editor = makeEditor();
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);
    client.init();

    vsCode.postMessage.mockClear();

    // Fire Ctrl+Z — TipTap handles it internally; extension must NOT post an 'undo' message
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

    const undoCalls = vsCode.postMessage.mock.calls.filter((c: any[]) => c[0].type === 'undo');
    expect(undoCalls).toHaveLength(0);

    client.dispose();
  });

  it('init suppresses history via chain + addToHistory meta', () => {
    const editor = makeEditor();
    const client = new SyncClient(editor as any, makeVsCode());
    client.handleMessage({ type: 'init', markdown: '# Hello' });
    const chainObj = (editor.chain as any).mock.results[0].value;
    expect(editor.chain).toHaveBeenCalled();
    expect(chainObj.command).toHaveBeenCalled();
    const metaCallback = chainObj.command.mock.calls[0][0];
    const setMeta = vi.fn();
    metaCallback({ tr: { setMeta } });
    expect(setMeta).toHaveBeenCalledWith('addToHistory', false);
    expect(chainObj.run).toHaveBeenCalled();
  });

  it('externalUpdate suppresses history via chain + addToHistory meta', () => {
    const editor = makeEditor();
    // Return different content so applyExternalUpdate does not short-circuit
    editor.storage.markdown.getMarkdown.mockReturnValue('# Old');
    const client = new SyncClient(editor as any, makeVsCode());
    client.handleMessage({ type: 'externalUpdate', markdown: '# New', version: 1 });
    const chainObj = (editor.chain as any).mock.results[0].value;
    expect(chainObj.command).toHaveBeenCalled();
    const metaCallback = chainObj.command.mock.calls[0][0];
    const setMeta = vi.fn();
    metaCallback({ tr: { setMeta } });
    expect(setMeta).toHaveBeenCalledWith('addToHistory', false);
  });
});
