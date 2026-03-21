import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { CommentThread, PendingComment } from '../sync/commentTypes';
import type { LineMap } from './lineMap';
import { findPosForLine } from './lineMap';

export interface CommentIndicatorState {
  reviewMode: boolean;
  /** 1-indexed working-copy line numbers from the diff mapper */
  diffHighlightLines: number[];
  threads: CommentThread[];
  pendingComments: PendingComment[];
  lineMap: LineMap | null;
}

const PLUGIN_KEY = new PluginKey<CommentIndicatorState>('commentIndicator');

const emptyState: CommentIndicatorState = {
  reviewMode: false,
  diffHighlightLines: [],
  threads: [],
  pendingComments: [],
  lineMap: null,
};

export function createCommentIndicatorPlugin(): Plugin<CommentIndicatorState> {
  return new Plugin<CommentIndicatorState>({
    key: PLUGIN_KEY,
    state: {
      init(): CommentIndicatorState {
        return emptyState;
      },
      apply(tr, prev): CommentIndicatorState {
        const meta = tr.getMeta(PLUGIN_KEY);
        if (meta) return meta;
        return prev;
      },
    },
    props: {
      decorations(state): DecorationSet {
        const pluginState = PLUGIN_KEY.getState(state);
        if (!pluginState || !pluginState.reviewMode || !pluginState.lineMap) {
          return DecorationSet.empty;
        }
        return buildDecorations(state.doc, pluginState);
      },
    },
  });
}

export function updateCommentIndicatorState(
  view: EditorView,
  newState: CommentIndicatorState,
): void {
  const tr = view.state.tr.setMeta(PLUGIN_KEY, newState);
  view.dispatch(tr);
}

export function getCommentIndicatorState(view: EditorView): CommentIndicatorState {
  return PLUGIN_KEY.getState(view.state) ?? emptyState;
}

function buildDecorations(doc: PmNode, state: CommentIndicatorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { lineMap, diffHighlightLines, threads, pendingComments } = state;
  if (!lineMap) return DecorationSet.empty;

  // Build lookup sets for lines that already have threads
  const commentedLines = new Set<number>();
  const commentCounts = new Map<number, number>();
  for (const thread of threads) {
    commentedLines.add(thread.workingCopyLine);
    commentCounts.set(
      thread.workingCopyLine,
      (commentCounts.get(thread.workingCopyLine) || 0) + thread.comments.length,
    );
  }

  const pendingCounts = new Map<number, number>();
  for (const pc of pendingComments) {
    pendingCounts.set(
      pc.workingCopyLine,
      (pendingCounts.get(pc.workingCopyLine) || 0) + 1,
    );
  }

  // Diff highlight decorations (green background).
  // diffHighlightLines are 1-indexed working-copy line numbers (from the diff mapper's
  // `newLine` counter, which starts at the hunk header's newStart — always 1-indexed).
  // findPosForLine expects 0-indexed markdown line numbers (lineMap convention).
  // Subtract 1 to convert.
  for (const line1 of diffHighlightLines) {
    const line0 = line1 - 1;
    const pos = findPosForLine(lineMap, line0);
    if (pos === null) continue;
    const node = doc.nodeAt(pos);
    if (!node) continue;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'diff-highlight',
      }),
    );
  }

  // Comment highlight decorations + badge widgets.
  // workingCopyLine on threads is also 1-indexed — subtract 1 for lineMap lookup.
  for (const thread of threads) {
    const line0 = thread.workingCopyLine - 1;
    const pos = findPosForLine(lineMap, line0);
    if (pos === null) continue;
    const node = doc.nodeAt(pos);
    if (!node) continue;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'comment-highlight',
      }),
    );

    const count = thread.comments.length;
    const pendingCount = pendingCounts.get(thread.workingCopyLine) || 0;
    const badgeText = pendingCount > 0 ? `${count}+${pendingCount}` : `${count}`;

    decorations.push(
      Decoration.widget(pos + node.nodeSize, () => {
        const badge = document.createElement('span');
        badge.className = 'comment-badge';
        badge.textContent = badgeText;
        badge.dataset.line = String(thread.workingCopyLine);
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          document.dispatchEvent(
            new CustomEvent('comment-badge-click', {
              detail: { threadId: thread.id, line: thread.workingCopyLine },
            }),
          );
        });
        return badge;
      }, { side: 1 }),
    );
  }

  // Pending-only comment indicators (lines with pending comments but no existing thread).
  // workingCopyLine on PendingComment is also 1-indexed.
  for (const pc of pendingComments) {
    if (commentedLines.has(pc.workingCopyLine)) continue;
    const line0 = pc.workingCopyLine - 1;
    const pos = findPosForLine(lineMap, line0);
    if (pos === null) continue;
    const node = doc.nodeAt(pos);
    if (!node) continue;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'comment-highlight-pending',
      }),
    );

    const count = pendingCounts.get(pc.workingCopyLine) || 1;
    decorations.push(
      Decoration.widget(pos + node.nodeSize, () => {
        const badge = document.createElement('span');
        badge.className = 'comment-badge pending';
        badge.textContent = `+${count}`;
        badge.dataset.line = String(pc.workingCopyLine);
        return badge;
      }, { side: 1 }),
    );
  }

  return DecorationSet.create(doc, decorations);
}
