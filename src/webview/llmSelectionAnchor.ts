import type { Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { LlmCommentStore } from './llmCommentStore';
import type { CommentPanel } from './commentPanel';
import type { LineMap, LineRange } from './lineMap';

/**
 * Shows a floating `+` button above a live text selection inside the editor.
 * Clicking the button applies the `llmComment` mark to the selection and
 * opens the comment panel in `openLlmNewText` mode. The panel is responsible
 * for unwinding the mark if the user closes without saving (Phase 4).
 */
export class LlmSelectionAnchor {
  private editor: Editor;
  private store: LlmCommentStore;
  private panel: CommentPanel;
  private btn: HTMLButtonElement;
  private active = false;
  private editorElement: HTMLElement;
  private getLineMap: () => LineMap | null;
  private selectionHandler: () => void;

  constructor(
    editor: Editor,
    store: LlmCommentStore,
    panel: CommentPanel,
    editorElement: HTMLElement,
    getLineMap: () => LineMap | null,
  ) {
    this.editor = editor;
    this.store = store;
    this.panel = panel;
    this.editorElement = editorElement;
    this.getLineMap = getLineMap;

    this.btn = document.createElement('button');
    this.btn.className = 'llm-selection-plus';
    this.btn.type = 'button';
    this.btn.textContent = '+';
    this.btn.title = 'Add LLM-Assist comment';
    this.btn.style.display = 'none';
    this.btn.addEventListener('mousedown', (e) => {
      // Prevent the click from collapsing the selection before our handler runs.
      e.preventDefault();
    });
    this.btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleClick();
    });
    document.body.appendChild(this.btn);

    this.selectionHandler = () => this.updateVisibility();
    document.addEventListener('selectionchange', this.selectionHandler);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.hide();
  }

  isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.selectionHandler);
    this.btn.remove();
  }

  private hide(): void {
    this.btn.style.display = 'none';
  }

  private show(): void {
    this.btn.style.display = 'flex';
  }

  private updateVisibility(): void {
    if (!this.active) {
      this.hide();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hide();
      return;
    }
    const range = sel.getRangeAt(0);
    // Reject selections whose common ancestor is outside the editor element.
    const ancestor = range.commonAncestorContainer;
    const ancestorEl =
      ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentElement;
    if (!ancestorEl || !this.editorElement.contains(ancestorEl)) {
      this.hide();
      return;
    }

    this.positionNearSelection();
    this.show();
  }

  private positionNearSelection(): void {
    const { view } = this.editor;
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);

    if (start && end) {
      // Render the + ABOVE the selection.
      const midX = (start.left + end.right) / 2;
      const topY = Math.min(start.top, end.top);
      let left = midX - 13; // button is 26px wide
      const top = topY - 34; // 26px button + 8px gap above the selection

      // Right-edge clamp.
      const btnWidth = 26;
      const maxLeft = window.innerWidth - btnWidth - 16;
      if (left > maxLeft) left = maxLeft;
      if (left < 16) left = 16;

      this.btn.style.left = `${left}px`;
      this.btn.style.top = `${top}px`;
    } else {
      // Fallback to editor centre.
      const editorRect = view.dom.getBoundingClientRect();
      this.btn.style.left = `${editorRect.left + editorRect.width / 2 - 13}px`;
      this.btn.style.top = `${editorRect.top + 20}px`;
    }
  }

  private handleClick(): void {
    if (!this.active) return;
    const { view } = this.editor;
    const { from, to } = view.state.selection;
    if (from === to) return;

    const doc = view.state.doc;
    let selectedText = '';
    try {
      const slice = doc.slice(from, to);
      const wrappedDoc = this.editor.schema.topNodeType.create(null, slice.content);
      const raw: string = this.editor.storage.markdown.serializer.serialize(wrappedDoc);
      selectedText = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    } catch {
      selectedText = typeof doc.textBetween === 'function'
        ? doc.textBetween(from, to, '\n\n')
        : '';
    }

    // Resolve the block ancestors for `from` and `to - 1` (so the end
    // position is inside the ending block, not past it).
    const $from = view.state.doc.resolve(from);
    const $to = view.state.doc.resolve(Math.max(to - 1, from));

    const lineMap = this.getLineMap();
    if (!lineMap) return;

    // Walk from the deepest ancestor down to depth 1, preferring the most-specific
    // commentable block so nested list comments anchor to the inner listItem, not
    // the outer list.
    const startResult = findBlockPosInLineMap($from, lineMap);
    const endResult = findBlockPosInLineMap($to, lineMap);

    // Derive line numbers from whatever resolved (fallback to 1/1 so the user
    // always gets feedback — line numbers are metadata; the mark is what matters).
    const resolvedStartRange = startResult?.range ?? endResult?.range;
    const resolvedEndRange = endResult?.range ?? startResult?.range;

    // Convert 0-indexed startLine to 1-indexed.
    const startLine = resolvedStartRange ? resolvedStartRange.startLine + 1 : 1;
    // `endLine` in posToLineRange is EXCLUSIVE. Treating the exclusive end as
    // the inclusive 1-indexed last line is correct due to the off-by-one.
    // Example: {startLine:0, endLine:1} → 1-indexed lines 1..1 → last = 1 = endLine.
    const endLineInclusive = resolvedEndRange ? resolvedEndRange.endLine : 1;

    const commentId = this.makeId();

    // Apply the mark immediately — user sees the highlight before typing.
    this.editor.chain().focus().setLlmComment({ commentId }).run();

    // Find the first rendered span carrying the new id to use as the anchor.
    let anchorEl = document.querySelector(
      `[data-llm-comment-id="${commentId}"]`,
    ) as HTMLElement | null;

    if (!anchorEl) {
      // Mark not applied (e.g. code block). Use the deepest resolved block
      // element at the selection start as anchor so the panel appears next to it.
      const domAtStart = startResult
        ? view.nodeDOM(startResult.pos)
        : view.nodeDOM($from.before(1));
      anchorEl =
        domAtStart instanceof HTMLElement
          ? domAtStart
          : (view.dom as HTMLElement);
    }

    this.panel.openLlmNewText(commentId, anchorEl, startLine, endLineInclusive, selectedText);

    this.hide();
  }

  private makeId(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Walk from the deepest wrapping block ancestor down to depth 1, returning the
 * first position that exists in the lineMap. This prefers the most-specific
 * commentable block so nested list comments anchor to the inner listItem, not
 * the outer list.
 */
function findBlockPosInLineMap(
  $pos: ResolvedPos,
  lineMap: LineMap,
): { pos: number; range: LineRange } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const pos = $pos.before(d);
    const range = lineMap.posToLineRange.get(pos);
    if (range) return { pos, range };
  }
  return null;
}
