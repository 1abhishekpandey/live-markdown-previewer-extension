// @vitest-environment happy-dom

let lastPluginSpec: any = null;

vi.mock('@tiptap/pm/state', () => ({
  Plugin: class {
    constructor(spec: any) {
      lastPluginSpec = spec;
    }
  },
  PluginKey: class {
    getState() { return undefined; }
  },
}));

vi.mock('@tiptap/core', () => ({
  Editor: class {},
  Extension: { create: vi.fn((config: unknown) => config) },
}));

import { setCopyMode, getCopyMode, CopyToolbarExtension } from '../../webview/copyToolbar';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  setCopyMode(true);
});

describe('getCopyMode / setCopyMode', () => {
  it('defaults to true (raw mode)', () => {
    expect(getCopyMode()).toBe(true);
  });

  it('setCopyMode(false) switches to rendered', () => {
    setCopyMode(false);
    expect(getCopyMode()).toBe(false);
  });

  it('setCopyMode(true) switches back to raw', () => {
    setCopyMode(false);
    setCopyMode(true);
    expect(getCopyMode()).toBe(true);
  });
});

describe('CopyToolbarExtension', () => {
  it('is exported from the module', async () => {
    const mod = await import('../../webview/copyToolbar');
    expect(mod.CopyToolbarExtension).toBeDefined();
  });

  it('has expected shape from Extension.create mock', async () => {
    const mod = await import('../../webview/copyToolbar');
    // Extension.create is mocked to return its config argument, so the export
    // should be the config object with at minimum a name property
    expect(mod.CopyToolbarExtension).toHaveProperty('name', 'copyToolbar');
  });

  it('has addProseMirrorPlugins function', async () => {
    const mod = await import('../../webview/copyToolbar');
    expect(typeof (mod.CopyToolbarExtension as { addProseMirrorPlugins?: unknown }).addProseMirrorPlugins).toBe('function');
  });
});

describe('copy mode state isolation', () => {
  it('toggling mode multiple times ends at expected value', () => {
    setCopyMode(false);
    setCopyMode(true);
    setCopyMode(false);
    expect(getCopyMode()).toBe(false);
  });

  it('raw mode is the default after reset in afterEach', () => {
    // afterEach calls setCopyMode(true); this test verifies the reset is effective
    expect(getCopyMode()).toBe(true);
  });
});

describe('copy event interception', () => {
  function getCopyHandler() {
    const ext = CopyToolbarExtension as any;
    const mockSerializer = { serialize: vi.fn(() => '**bold**') };
    const mockEditor = {
      state: {
        selection: { from: 0, to: 5 },
        doc: { slice: vi.fn(() => ({ content: 'mock-content' })) },
      },
      storage: { markdown: { serializer: mockSerializer } },
    };
    ext.addProseMirrorPlugins.call({ editor: mockEditor });
    const handler = lastPluginSpec?.props?.handleDOMEvents?.copy;
    return { handler, mockEditor, mockSerializer };
  }

  function createMockEvent() {
    const clipboardData = { setData: vi.fn() };
    const event = { preventDefault: vi.fn(), clipboardData } as unknown as ClipboardEvent;
    return event;
  }

  function createMockView(from: number, to: number) {
    return {
      state: {
        selection: { from, to },
        doc: { slice: vi.fn(() => ({ content: 'mock-content' })) },
      },
    };
  }

  it('in raw mode, intercepts copy and writes text/plain only', () => {
    setCopyMode(true);
    const { handler, mockSerializer } = getCopyHandler();
    const event = createMockEvent();
    const view = createMockView(0, 5);

    const result = handler(view, event);

    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect((event.clipboardData as any).setData).toHaveBeenCalledWith('text/plain', '**bold**');
    expect(mockSerializer.serialize).toHaveBeenCalled();
  });

  it('in rich mode, does not intercept copy', () => {
    setCopyMode(false);
    const { handler } = getCopyHandler();
    const event = createMockEvent();
    const view = createMockView(0, 5);

    const result = handler(view, event);

    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('with empty selection, does not intercept regardless of mode', () => {
    setCopyMode(true);
    const { handler } = getCopyHandler();
    const event = createMockEvent();
    const view = createMockView(3, 3);

    const result = handler(view, event);

    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
