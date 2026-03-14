// @vitest-environment happy-dom

vi.mock('@tiptap/core', () => ({
  Editor: class {},
  Extension: { create: vi.fn() },
}));

import { SyncClient } from '../../webview/syncClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditor(dom?: HTMLElement) {
  const setContent = vi.fn();
  const setEditable = vi.fn();
  const getMarkdown = vi.fn().mockReturnValue('');
  const setTextSelection = vi.fn();
  return {
    on: vi.fn(),
    commands: { setContent, focus: vi.fn(), setTextSelection },
    setEditable,
    storage: {
      markdown: { getMarkdown },
      localImage: { documentDirUri: '' },
    },
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
      dom: dom ?? null,
    },
  };
}

function makeVsCode() {
  return { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
}

function buildEditorDOM(innerHTML: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = innerHTML;
  document.body.appendChild(el);
  return el;
}

function mockRect(el: Element, rect: Partial<DOMRect>) {
  const full = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ ...full, ...rect } as DOMRect);
}

function mockScrollState(opts: { scrollY?: number; innerHeight?: number; scrollHeight?: number }) {
  if (opts.scrollY != null) {
    Object.defineProperty(window, 'scrollY', { value: opts.scrollY, writable: true, configurable: true });
  }
  if (opts.innerHeight != null) {
    Object.defineProperty(window, 'innerHeight', { value: opts.innerHeight, writable: true, configurable: true });
  }
  if (opts.scrollHeight != null) {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: opts.scrollHeight, writable: true, configurable: true });
  }
}

/** Init the client + flush rAF so the initial computeAndSendAnchor fires. */
function initClient(client: SyncClient, markdown = '# Hello') {
  client.handleMessage({ type: 'init', markdown });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Group 1: extractElementText — via computeAndSendAnchor (scroll → rAF → post)
// ---------------------------------------------------------------------------

describe('extractElementText (via scroll anchor computation)', () => {
  function setupAndScroll(dom: HTMLElement) {
    const editor = makeEditor(dom);
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1600 });

    client.init();
    initClient(client);

    // Clear init messages
    vsCode.postMessage.mockClear();

    // Dispatch scroll to trigger computeAndSendAnchor
    window.dispatchEvent(new Event('scroll'));

    rafSpy.mockRestore();
    client.dispose();
    return vsCode;
  }

  it('TH/TD returns joined row text', () => {
    const dom = buildEditorDOM('<table><tbody><tr><th>Name</th><th>Age</th></tr></tbody></table>');
    // Make the first TH visible
    const th = dom.querySelector('th')!;
    mockRect(th, { top: 10, bottom: 30 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'Name  Age',
    }));
  });

  it('TD with 3 cells returns joined text', () => {
    const dom = buildEditorDOM('<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>');
    const td = dom.querySelector('td')!;
    mockRect(td, { top: 10, bottom: 30 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'a  b  c',
    }));
  });

  it('LI with direct P child returns P text', () => {
    const dom = buildEditorDOM('<ul><li><p>Item text</p></li></ul>');
    const li = dom.querySelector('li')!;
    mockRect(li, { top: 10, bottom: 30 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'Item text',
    }));
  });

  it('LI without P skips nested UL children', () => {
    const dom = buildEditorDOM('<ul><li>Top<strong>bold</strong><ul><li>nested</li></ul></li></ul>');
    // The outer LI has a nested UL, so computeAndSendAnchor looks for :scope > p.
    // No direct P → the LI with nested UL is skipped (continue).
    // The inner LI "nested" should be picked instead.
    const innerLi = dom.querySelectorAll('li')[1]; // nested li
    mockRect(innerLi, { top: 10, bottom: 30 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'nested',
    }));
  });

  it('PRE returns first non-empty code line', () => {
    const dom = buildEditorDOM('<pre><code>\nfunction hello() {\n}\n</code></pre>');
    const pre = dom.querySelector('pre')!;
    mockRect(pre, { top: 10, bottom: 200, height: 200 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'function hello() {',
    }));
  });

  it('default element returns trimmed textContent', () => {
    const dom = buildEditorDOM('<h2>  Section Title  </h2>');
    const h2 = dom.querySelector('h2')!;
    mockRect(h2, { top: 10, bottom: 30 });

    const vsCode = setupAndScroll(dom);
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'Section Title',
    }));
  });
});

// ---------------------------------------------------------------------------
// Group 2: computeAndSendAnchor — via init() + scroll
// ---------------------------------------------------------------------------

describe('computeAndSendAnchor', () => {
  function setupClient(dom: HTMLElement | null) {
    const editor = makeEditor(dom ?? undefined);
    if (!dom) editor.view.dom = null;
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });

    client.init();
    initClient(client);
    vsCode.postMessage.mockClear();

    return { editor, vsCode, client, rafSpy };
  }

  it('posts empty anchorText when editor.view.dom is null', () => {
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1600 });
    const { vsCode, client, rafSpy } = setupClient(null);

    window.dispatchEvent(new Event('scroll'));

    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: '',
    }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('posts empty anchorText when DOM has no block elements', () => {
    const dom = buildEditorDOM('');
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1600 });
    const { vsCode, client, rafSpy } = setupClient(dom);

    window.dispatchEvent(new Event('scroll'));

    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: '',
    }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('finds first visible paragraph', () => {
    const dom = buildEditorDOM('<p>First visible</p>');
    const p = dom.querySelector('p')!;
    mockRect(p, { top: 10, bottom: 30 });
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1600 });

    const { vsCode, client, rafSpy } = setupClient(dom);

    window.dispatchEvent(new Event('scroll'));

    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'First visible',
    }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('skips elements scrolled past (rect.bottom <= 5)', () => {
    const dom = buildEditorDOM('<p>Scrolled past</p><p>Visible</p>');
    const paragraphs = dom.querySelectorAll('p');
    mockRect(paragraphs[0], { top: -50, bottom: 3 }); // scrolled past
    mockRect(paragraphs[1], { top: 10, bottom: 30 });  // visible
    mockScrollState({ scrollY: 100, innerHeight: 800, scrollHeight: 1600 });

    const { vsCode, client, rafSpy } = setupClient(dom);

    window.dispatchEvent(new Event('scroll'));

    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'Visible',
    }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('skips P inside LI, matches LI instead', () => {
    const dom = buildEditorDOM('<ul><li><p>List item text</p></li></ul>');
    const li = dom.querySelector('li')!;
    const p = dom.querySelector('p')!;
    mockRect(li, { top: 10, bottom: 30 });
    mockRect(p, { top: 10, bottom: 30 });
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1600 });

    const { vsCode, client, rafSpy } = setupClient(dom);

    window.dispatchEvent(new Event('scroll'));

    // P inside LI is skipped; LI doesn't have nested UL/OL so it's measured directly
    // but the LI doesn't match the branch with nested ul/ol, so it falls through to
    // the normal measurement. The P's parent is LI → P is skipped. LI is measured.
    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      anchorText: 'List item text',
    }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('clamps roughFraction to [0,1] when scrollable is 0', () => {
    const dom = buildEditorDOM('<p>Short doc</p>');
    const p = dom.querySelector('p')!;
    mockRect(p, { top: 10, bottom: 30 });
    // scrollHeight === innerHeight → scrollable = 0
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 800 });

    const { vsCode, client, rafSpy } = setupClient(dom);

    window.dispatchEvent(new Event('scroll'));

    expect(vsCode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrollAnchorUpdate',
      roughFraction: 0,
    }));
    rafSpy.mockRestore();
    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// Group 3: applyScrollAnchor — via handleMessage('scrollToAnchor') after init
// ---------------------------------------------------------------------------

describe('applyScrollAnchor (via scrollToAnchor message)', () => {
  function setupForScroll(domHtml: string) {
    const dom = buildEditorDOM(domHtml);
    const editor = makeEditor(dom);
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    client.init();
    initClient(client);
    vsCode.postMessage.mockClear();

    return { dom, editor, vsCode, client, rafSpy, scrollToSpy };
  }

  it('scrolls to matching element via DOM text match', () => {
    const { dom, client, scrollToSpy, rafSpy } = setupForScroll('<p>Target paragraph</p>');
    const p = dom.querySelector('p')!;
    mockRect(p, { top: 200, bottom: 220 });
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 2000 });
    // targetScrollY = rect.top(200) + scrollY(0) = 200
    // Make scrollTo land at target so no retry
    scrollToSpy.mockImplementation(() => {
      Object.defineProperty(window, 'scrollY', { value: 200, writable: true, configurable: true });
    });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Target paragraph',
      lineIndex: 5,
      totalLines: 100,
      roughFraction: 0.05,
    });

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 200 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('falls back to percentage when no text match', () => {
    const { client, scrollToSpy, rafSpy } = setupForScroll('<p>Something else</p>');
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // scrollable = 1800 - 800 = 1000, roughFraction = 0.5 → target = 500
    Object.defineProperty(window, 'scrollY', { value: 500, writable: true, configurable: true });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'nonexistent text',
      lineIndex: 50,
      totalLines: 100,
      roughFraction: 0.5,
    });

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 500 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('returns early when scrollable <= 0', () => {
    const { client, scrollToSpy, rafSpy } = setupForScroll('<p>Short</p>');
    // scrollHeight < innerHeight → scrollable < 0
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 700 });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Short',
      lineIndex: 0,
      totalLines: 1,
      roughFraction: 0,
    });

    expect(scrollToSpy).not.toHaveBeenCalled();
    rafSpy.mockRestore();
    client.dispose();
  });

  it('uses roughFraction for percentage fallback', () => {
    const { client, scrollToSpy, rafSpy } = setupForScroll('<p>Other</p>');
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // scrollable = 1000, roughFraction = 0.3 → target = 300
    Object.defineProperty(window, 'scrollY', { value: 300, writable: true, configurable: true });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'no match here',
      lineIndex: 0,
      totalLines: 1,
      roughFraction: 0.3,
    });

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 300 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('falls back to lineIndex/totalLines when roughFraction undefined', () => {
    const { client, scrollToSpy, rafSpy } = setupForScroll('<p>Other</p>');
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // scrollable = 1000, lineIndex=50, totalLines=101 → fraction = 50/100 = 0.5 → target = 500
    Object.defineProperty(window, 'scrollY', { value: 500, writable: true, configurable: true });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'no match',
      lineIndex: 50,
      totalLines: 101,
      // roughFraction intentionally omitted
    } as any);

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 500 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('retries when scroll drifts >10px', () => {
    vi.useFakeTimers();
    const dom = buildEditorDOM('<p>Other</p>');
    const editor = makeEditor(dom);
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    client.init();
    initClient(client);

    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // scrollable=1000, fraction=0.5 → target=500, but scrollY stays 0 → drift=500 > 10

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'no match',
      lineIndex: 50,
      totalLines: 100,
      roughFraction: 0.5,
    });

    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // Advance 50ms — retry should fire
    vi.advanceTimersByTime(50);
    expect(scrollToSpy).toHaveBeenCalledTimes(2);

    rafSpy.mockRestore();
    client.dispose();
    vi.useRealTimers();
  });

  it('does not retry when within 10px', () => {
    vi.useFakeTimers();
    const dom = buildEditorDOM('<p>Match</p>');
    const editor = makeEditor(dom);
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    client.init();
    initClient(client);

    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // scrollable=1000, fraction=0.5 → target=500
    // Simulate scrollTo landing at the right position
    scrollToSpy.mockImplementation(() => {
      Object.defineProperty(window, 'scrollY', { value: 500, writable: true, configurable: true });
    });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'no match',
      lineIndex: 50,
      totalLines: 100,
      roughFraction: 0.5,
    });

    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // Advance 50ms — no retry expected
    vi.advanceTimersByTime(50);
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    rafSpy.mockRestore();
    client.dispose();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Group 4: findElementByText — via scrollToAnchor
// ---------------------------------------------------------------------------

describe('findElementByText (via scrollToAnchor)', () => {
  function setupForScroll(domHtml: string) {
    const dom = buildEditorDOM(domHtml);
    const editor = makeEditor(dom);
    const vsCode = makeVsCode();
    const client = new SyncClient(editor as any, vsCode);

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { (cb as FrameRequestCallback)(0); return 0; });
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    client.init();
    initClient(client);
    vsCode.postMessage.mockClear();

    return { dom, editor, vsCode, client, rafSpy, scrollToSpy };
  }

  it('falls back to percentage when anchorText is empty', () => {
    const { client, scrollToSpy, rafSpy } = setupForScroll('<p>Content</p>');
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    Object.defineProperty(window, 'scrollY', { value: 500, writable: true, configurable: true });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: '',
      lineIndex: 50,
      totalLines: 100,
      roughFraction: 0.5,
    });

    // Empty anchorText → findElementByText returns null → percentage fallback
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 500 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('deduplicates table cells per row', () => {
    const { dom, client, scrollToSpy, rafSpy } = setupForScroll(
      '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>'
    );
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    const firstTd = dom.querySelector('td')!;
    mockRect(firstTd, { top: 150, bottom: 170 });
    // targetScrollY = rect.top(150) + scrollY(0) = 150
    scrollToSpy.mockImplementation(() => {
      Object.defineProperty(window, 'scrollY', { value: 150, writable: true, configurable: true });
    });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'A  B',
      lineIndex: 0,
      totalLines: 10,
      roughFraction: 0,
    });

    // Should find the row via the first TD and scroll to it
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 150 }));
    rafSpy.mockRestore();
    client.dispose();
  });

  it('disambiguates multiple matches using roughFraction', () => {
    const { dom, client, scrollToSpy, rafSpy } = setupForScroll(
      '<p>Repeated</p><p>Spacer</p><p>Spacer2</p><p>Repeated</p>'
    );
    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });

    const paragraphs = dom.querySelectorAll('p');
    mockRect(paragraphs[0], { top: 50, bottom: 70 });
    mockRect(paragraphs[3], { top: 600, bottom: 620 });

    mockScrollState({ scrollY: 0, innerHeight: 800, scrollHeight: 1800 });
    // roughFraction=0.9 should pick the second "Repeated" (index 3 out of 4 → fraction ~1.0)
    // targetScrollY = rect.top(600) + scrollY(0) = 600
    scrollToSpy.mockImplementation(() => {
      Object.defineProperty(window, 'scrollY', { value: 600, writable: true, configurable: true });
    });

    client.handleMessage({
      type: 'scrollToAnchor',
      anchorText: 'Repeated',
      lineIndex: 90,
      totalLines: 100,
      roughFraction: 0.9,
    });

    // The second "Repeated" is at position 600
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 600 }));
    rafSpy.mockRestore();
    client.dispose();
  });
});
