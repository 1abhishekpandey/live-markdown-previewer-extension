import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { CommentThread, PendingComment } from '../sync/commentTypes';
import type { LineMap } from './lineMap';
import { findPosForLine } from './lineMap';
import type { LlmComment } from './llmCommentStore';

export interface CommentIndicatorState {
  reviewMode: boolean;
  /** 1-indexed working-copy line numbers from the diff mapper */
  diffHighlightLines: number[];
  threads: CommentThread[];
  pendingComments: PendingComment[];
  lineMap: LineMap | null;
  llmAssistActive?: boolean;
  llmComments?: LlmComment[];
  activeLlmLine?: number | null;
}

const PLUGIN_KEY = new PluginKey<CommentIndicatorState>('commentIndicator');

const emptyState: CommentIndicatorState = {
  reviewMode: false,
  diffHighlightLines: [],
  threads: [],
  pendingComments: [],
  lineMap: null,
  llmAssistActive: false,
  llmComments: [],
  activeLlmLine: null,
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
        if (!pluginState || !pluginState.lineMap) {
          return DecorationSet.empty;
        }
        const llmAssistActive = pluginState.llmAssistActive ?? false;
        if (!pluginState.reviewMode && !llmAssistActive) {
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
  const { lineMap, diffHighlightLines, threads, pendingComments, reviewMode } = state;
  const llmAssistActive = state.llmAssistActive ?? false;
  const llmComments = state.llmComments ?? [];
  if (!lineMap) return DecorationSet.empty;

  // LLM-Assist branch — mutually exclusive with review mode.
  if (llmAssistActive && !reviewMode) {
    return buildLlmDecorations(doc, lineMap, llmComments, state.activeLlmLine);
  }

  // Review-mode branch.
  if (!reviewMode) return DecorationSet.empty;

  const decorations: Decoration[] = [];

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
        'data-diff-line': String(line1),
      }),
    );
  }

  // Comment highlight decorations for existing threads.
  // Uses node decoration with data attributes + ::after for the badge (no widget decoration).
  for (const thread of threads) {
    const line0 = thread.workingCopyLine - 1;
    const pos = findPosForLine(lineMap, line0);
    if (pos === null) continue;
    const node = doc.nodeAt(pos);
    if (!node) continue;

    const count = thread.comments.length;
    const pendingCount = pendingCounts.get(thread.workingCopyLine) || 0;
    const badgeText = pendingCount > 0 ? `${count}+${pendingCount}` : `${count}`;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'comment-highlight',
        'data-comment-count': badgeText,
        'data-thread-id': String(thread.id),
        'data-thread-line': String(thread.workingCopyLine),
      }),
    );
  }

  // Pending-only comment indicators (lines with pending comments but no existing thread).
  // Track which lines already have pending decoration to avoid duplicates.
  const pendingDecoratedLines = new Set<number>();
  for (const pc of pendingComments) {
    if (commentedLines.has(pc.workingCopyLine)) continue;

    // Determine the line range: startLine..endLine for multi-line, or just endLine
    const startLine1 = pc.workingCopyStartLine ?? pc.workingCopyLine;
    const endLine1 = pc.workingCopyLine;

    for (let line1 = startLine1; line1 <= endLine1; line1++) {
      if (pendingDecoratedLines.has(line1)) continue;
      pendingDecoratedLines.add(line1);

      const line0 = line1 - 1;
      const pos = findPosForLine(lineMap, line0);
      if (pos === null) continue;
      const node = doc.nodeAt(pos);
      if (!node) continue;

      const count = pendingCounts.get(pc.workingCopyLine) || 1;
      const isEndLine = line1 === endLine1;

      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'comment-highlight-pending',
          // On the end line, store count + line for the badge and click handling
          ...(isEndLine ? {
            'data-pending-count': String(count),
            'data-pending-line': String(pc.workingCopyLine),
            'data-pending-start-line': pc.workingCopyStartLine ? String(pc.workingCopyStartLine) : '',
          } : {}),
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

const LLM_COMMENTABLE_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'codeBlock',
  'table',
]);

function buildLlmDecorations(
  doc: PmNode,
  lineMap: LineMap,
  llmComments: LlmComment[],
  activeLlmLine: number | null | undefined,
): DecorationSet {
  const decorations: Decoration[] = [];

  for (const [pos, range] of lineMap.posToLineRange) {
    const node = doc.nodeAt(pos);
    if (!node) continue;
    if (!LLM_COMMENTABLE_NODE_TYPES.has(node.type.name)) continue;

    // Convert 0-indexed to 1-indexed at the boundary.
    const line1 = range.startLine + 1;

    // Count root comments (not replies) whose range covers this line.
    const count = llmComments.filter(
      (c) => c.startLine <= line1 && line1 <= c.endLine && !c.parentId,
    ).length;

    if (count === 0) {
      const isActive = line1 === activeLlmLine;
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: isActive ? 'llm-line-commentable llm-line-active' : 'llm-line-commentable',
          'data-llm-line': String(line1),
        }),
      );
    } else {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'llm-line-commented',
          'data-llm-count': String(count),
          'data-llm-line': String(line1),
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}
