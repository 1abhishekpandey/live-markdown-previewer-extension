import type { Editor } from '@tiptap/core';
import type { LlmCommentStore } from './llmCommentStore';
import type { CommentPanel } from './commentPanel';
import type { LineMap } from './lineMap';

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
    const selectedText = typeof doc.textBetween === 'function'
      ? doc.textBetween(from, to, ' ')
      : '';

    // Resolve the top-level block ancestors for `from` and `to - 1` (so the end
    // position is inside the ending block, not past it).
    const $from = view.state.doc.resolve(from);
    const $to = view.state.doc.resolve(Math.max(to - 1, from));

    const startBlockPos = $from.before(1);
    const endBlockPos = $to.before(1);

    const lineMap = this.getLineMap();
    if (!lineMap) return;

    const startRange = lineMap.posToLineRange.get(startBlockPos);
    const endRange = lineMap.posToLineRange.get(endBlockPos);
    if (!startRange || !endRange) return;

    // Convert 0-indexed startLine to 1-indexed.
    const startLine = startRange.startLine + 1;
    // `endLine` in posToLineRange is EXCLUSIVE. Treating the exclusive end as
    // the inclusive 1-indexed last line is correct due to the off-by-one.
    // Example: {startLine:0, endLine:1} → 1-indexed lines 1..1 → last = 1 = endLine.
    const endLineInclusive = endRange.endLine;

    const commentId = this.makeId();

    // Apply the mark immediately — user sees the highlight before typing.
    this.editor.chain().focus().setLlmComment({ commentId }).run();

    // Find the first rendered span carrying the new id to use as the anchor.
    let anchorEl = document.querySelector(
      `[data-llm-comment-id="${commentId}"]`,
    ) as HTMLElement | null;

    if (!anchorEl) {
      // Mark not applied (e.g. code block). Use the block element at the
      // selection start as anchor so the panel appears next to it.
      const domAtStart = view.nodeDOM($from.before(1));
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
