// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmSelectionAnchor } from '../../webview/llmSelectionAnchor';
import { LlmCommentStore } from '../../webview/llmCommentStore';

function makeEditorElement(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'editor';
  el.textContent = 'hello world';
  document.body.appendChild(el);
  return el;
}

interface MockEditorOpts {
  from?: number;
  to?: number;
  coordsAtPos?: (pos: number) => { top: number; left: number; right: number; bottom: number };
}

interface MockEditor {
  view: {
    state: {
      selection: { from: number; to: number };
      doc: {
        resolve: (pos: number) => { before: (depth: number) => number };
      };
    };
    coordsAtPos: (pos: number) => { top: number; left: number; right: number; bottom: number };
    dom: HTMLElement;
  };
  chain: () => {
    focus: () => {
      setLlmComment: (attrs: { commentId: string }) => { run: () => boolean };
    };
  };
  __spies: { setLlmComment: ReturnType<typeof vi.fn>; unsetLlmCommentById: ReturnType<typeof vi.fn> };
}

function makeMockEditor(editorDom: HTMLElement, opts: MockEditorOpts = {}): MockEditor {
  const setLlmComment = vi.fn();
  const unsetLlmCommentById = vi.fn();
  const coordsAtPos =
    opts.coordsAtPos ??
    ((pos: number) => ({ top: 100, left: 50 + pos, right: 60 + pos, bottom: 120 }));
  return {
    view: {
      state: {
        selection: { from: opts.from ?? 1, to: opts.to ?? 5 },
        doc: {
          // Pretend the whole selection lives inside a single top-level block at pos 0.
          resolve: (_pos: number) => ({
            before: (_depth: number) => 0,
          }),
        },
      },
      coordsAtPos,
      dom: editorDom,
      nodeDOM: () => null,
    },
    chain: () => ({
      focus: () => ({
        setLlmComment: (attrs: { commentId: string }) => ({
          run: () => {
            setLlmComment(attrs);
            return true;
          },
        }),
      }),
    }),
    __spies: { setLlmComment, unsetLlmCommentById },
  };
}

function makeMockPanel() {
  return {
    openLlmNewText: vi.fn(),
  };
}

function makeLineMap() {
  return {
    posToLineRange: new Map([[0, { startLine: 0, endLine: 1 }]]),
    lineToPos: new Map(),
  };
}

// Helper: force a selection whose DOM range lives inside `el`. happy-dom does
// not implement selectAllChildren perfectly for editors, so construct a range
// explicitly.
function selectAllInside(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.addRange(range);
}

function collapseSelection(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(el.firstChild ?? el, 0);
  range.collapse(true);
  sel.addRange(range);
}

function fireSelectionChange(): void {
  document.dispatchEvent(new Event('selectionchange'));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // happy-dom persists innerWidth overrides across tests otherwise.
  // Re-set to a predictable default.
  try {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  } catch {
    /* no-op */
  }
});

describe('LlmSelectionAnchor', () => {
  it('A1: hidden when setActive(false) even with a real selection', () => {
    const editorEl = makeEditorElement();
    const editor = makeMockEditor(editorEl);
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    // Do NOT call setActive(true). Default is inactive.
    selectAllInside(editorEl);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.style.display).toBe('none');

    anchor.destroy();
  });

  it('A2: collapsed selection keeps it hidden', () => {
    const editorEl = makeEditorElement();
    const editor = makeMockEditor(editorEl, { from: 3, to: 3 });
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    anchor.setActive(true);
    collapseSelection(editorEl);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLElement;
    expect(btn.style.display).toBe('none');

    anchor.destroy();
  });

  it('A3: selection whose common ancestor is outside the editor keeps it hidden', () => {
    const editorEl = makeEditorElement();
    const editor = makeMockEditor(editorEl);
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    // Create a paragraph OUTSIDE the editor element.
    const outside = document.createElement('p');
    outside.textContent = 'not part of the editor';
    document.body.appendChild(outside);

    anchor.setActive(true);
    selectAllInside(outside);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLElement;
    expect(btn.style.display).toBe('none');

    anchor.destroy();
  });

  it('A4: right-edge clamp pins the button within window.innerWidth - 26 - 16', () => {
    // Pin the width so the clamp is deterministic.
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });

    const editorEl = makeEditorElement();
    // Return coords that would otherwise place the midpoint way off-screen to the right.
    const editor = makeMockEditor(editorEl, {
      coordsAtPos: () => ({ top: 200, left: 5000, right: 5100, bottom: 220 }),
    });
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    anchor.setActive(true);
    selectAllInside(editorEl);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLElement;
    // Button is shown.
    expect(btn.style.display).toBe('flex');
    // Clamped left = innerWidth - 26 - 16 = 800 - 42 = 758.
    expect(btn.style.left).toBe('758px');

    anchor.destroy();
  });

  it('A5: click triggers setLlmComment and panel.openLlmNewText once with the same id', () => {
    const editorEl = makeEditorElement();
    const editor = makeMockEditor(editorEl, { from: 1, to: 5 });
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    anchor.setActive(true);
    selectAllInside(editorEl);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLButtonElement;
    expect(btn.style.display).toBe('flex');

    btn.click();

    expect(editor.__spies.setLlmComment).toHaveBeenCalledTimes(1);
    const setCall = editor.__spies.setLlmComment.mock.calls[0][0];
    expect(setCall).toHaveProperty('commentId');
    const commentId = setCall.commentId as string;
    expect(typeof commentId).toBe('string');
    expect(commentId.length).toBeGreaterThan(0);

    expect(panel.openLlmNewText).toHaveBeenCalledTimes(1);
    const panelArgs = panel.openLlmNewText.mock.calls[0];
    expect(panelArgs[0]).toBe(commentId);
    // startLine = 0 + 1 = 1, endLineInclusive = 1 (exclusive end maps to inclusive 1-indexed last)
    expect(panelArgs[2]).toBe(1);
    expect(panelArgs[3]).toBe(1);

    anchor.destroy();
  });

  it('A6: click handler does not directly unwind the mark — it passes the same id through to the panel so the panel can unwind on cancel (Phase 4 wiring)', () => {
    const editorEl = makeEditorElement();
    const editor = makeMockEditor(editorEl, { from: 1, to: 5 });
    const store = new LlmCommentStore();
    const panel = makeMockPanel();
    const anchor = new LlmSelectionAnchor(
      editor as any,
      store,
      panel as any,
      editorEl,
      () => makeLineMap() as any,
    );

    anchor.setActive(true);
    selectAllInside(editorEl);
    fireSelectionChange();

    const btn = document.querySelector('.llm-selection-plus') as HTMLButtonElement;
    btn.click();

    // The anchor itself must NOT call unsetLlmCommentById — that is the panel's
    // job on close-without-save (Phase 4).
    expect(editor.__spies.unsetLlmCommentById).not.toHaveBeenCalled();

    // The id passed to setLlmComment is the same id handed to the panel, so the
    // panel has what it needs to unwind the mark on cancel.
    const idFromMark = editor.__spies.setLlmComment.mock.calls[0][0].commentId;
    const idFromPanel = panel.openLlmNewText.mock.calls[0][0];
    expect(idFromPanel).toBe(idFromMark);

    anchor.destroy();
  });
});
