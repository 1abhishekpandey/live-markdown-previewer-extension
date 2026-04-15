import './styles.css';
import { createEditor } from './editor';
import { unescapeInlineCode } from './markdownPostProcess';
import { SyncClient } from './syncClient';
import { setCopyMode } from './copyToolbar';
import { PendingCommentStore } from './pendingCommentStore';
import { CommentToggle } from './commentToggle';
import { CommentPanel } from './commentPanel';
import { createCommentIndicatorPlugin, updateCommentIndicatorState, getCommentIndicatorState } from './commentIndicator';
import { buildLineMap, type LineMap } from './lineMap';
import { LlmCommentStore } from './llmCommentStore';
import { LlmToggle } from './llmToggle';
import { LlmSelectionAnchor } from './llmSelectionAnchor';
import { dispatchLlmMessage, dispatchLlmEditorClick } from './llmDispatch';
import type { ExtensionToWebviewMessage, CommentDataMessage, ReviewSubmitResultMessage, CommentErrorMessage, LineMappingResultMessage, SavedPendingQueueMessage } from '../sync/syncProtocol';
import type { CommentThread } from '../sync/commentTypes';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const editorElement = document.getElementById('editor');
if (!editorElement) {
  throw new Error('Editor element not found');
}

const editor = createEditor(editorElement);
const loadingOverlay = document.getElementById('loading-overlay');
const safetyTimeout = setTimeout(() => {
  loadingOverlay?.classList.add('hidden');
}, 8000);

const syncClient = new SyncClient(editor, vscode, () => {
  clearTimeout(safetyTimeout);
  loadingOverlay?.classList.add('hidden');
});

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || typeof data.type !== 'string') return;
  if (data.type === 'debugLineInfo') {
    // Debug overlay hidden — logic retained in syncClient.updateDebugOverlay
    return;
  }

  // LLM-Assist: cache workspaceRelativePath from init, then fall through
  // so syncClient still handles the init message below.
  if (data.type === 'init') {
    const path = (data as { workspaceRelativePath?: unknown }).workspaceRelativePath;
    if (typeof path === 'string') {
      workspaceRelativePath = path;
      llmToggle.workspaceRelativePath = path;
    }
  }

  // Capture raw markdown from the extension side BEFORE syncClient.handleMessage
  // triggers editor updates. This ensures rebuildLlmLineMap uses the actual file
  // content (not the round-tripped serialisation) for line number mapping.
  if (data.type === 'init' || data.type === 'externalUpdate') {
    rawMarkdown = (data as { markdown?: string }).markdown ?? '';
    isExternallyUpdating = true;
  }

  // LLM-Assist: toggle command routed from the extension host
  if (dispatchLlmMessage(data, llmToggle)) return;

  // Comment system message routing
  if (data.type === 'commentData') {
    const msg = data as CommentDataMessage;
    commentToggle.handleCommentData(msg);
    lastThreads = msg.threads;

    // Build line map for position lookups
    const md = (editor.storage as any).markdown?.parser?.md;
    const markdown = unescapeInlineCode(editor.storage.markdown.getMarkdown());
    const lineMap = md ? buildLineMap(editor.state.doc, markdown, md) : null;

    // Update indicator plugin state
    updateCommentIndicatorState(editor.view, {
      reviewMode: true,
      diffHighlightLines: msg.diffHighlightLines,
      threads: msg.threads,
      pendingComments: pendingStore.getAll(),
      lineMap,
    });

    // Refresh panel if open
    commentPanel.refresh(msg.threads, pendingStore.getAll());
    return;
  }

  if (data.type === 'reviewSubmitResult') {
    const msg = data as ReviewSubmitResultMessage;
    commentToggle.handleSubmitResult(msg);
    if (msg.success) {
      pendingStore.clear();
    } else if (msg.failedReplyIds) {
      pendingStore.clearSuccessful(msg.failedReplyIds);
    }
    return;
  }

  if (data.type === 'commentError') {
    commentToggle.handleError(data as CommentErrorMessage);
    return;
  }

  if (data.type === 'lineMappingResult') {
    // Line validation response — update the pending comment's diffLine
    const result = data as LineMappingResultMessage;
    if (result.diffLine !== null) {
      const pc = pendingStore.get(result.tempId);
      if (pc) {
        pendingStore.remove(pc.tempId);
        pendingStore.add({ ...pc, diffLine: result.diffLine, diffStartLine: result.diffStartLine });
      }
    }
    return;
  }

  if (data.type === 'savedPendingQueue') {
    pendingStore.hydrate((data as SavedPendingQueueMessage).pending);
    return;
  }

  syncClient.handleMessage(data as ExtensionToWebviewMessage);

  if (isExternallyUpdating) {
    // Snapshot the serialised output AFTER setContent so the update handler
    // can detect real content changes vs mark-only changes.
    lastKnownSerialized = unescapeInlineCode(editor.storage.markdown.getMarkdown());
    isExternallyUpdating = false;
  }
});

// Code wrap toggle
const state = vscode.getState() as { codeWrap?: boolean } | null;
let codeWrap = state?.codeWrap ?? false;

const toggle = document.createElement('button');
toggle.className = 'code-wrap-toggle';
toggle.textContent = codeWrap ? 'Wrap: On' : 'Wrap: Off';
document.body.appendChild(toggle);

if (codeWrap) {
  editorElement.classList.add('code-wrap');
}

toggle.addEventListener('click', () => {
  codeWrap = !codeWrap;
  editorElement.classList.toggle('code-wrap', codeWrap);
  toggle.textContent = codeWrap ? 'Wrap: On' : 'Wrap: Off';
  vscode.setState({ ...((vscode.getState() as object) ?? {}), codeWrap });
});

// Copy mode toggle
let copyModeRaw = true;
setCopyMode(copyModeRaw);

const copyToggle = document.createElement('button');
copyToggle.className = 'copy-mode-toggle';
copyToggle.textContent = copyModeRaw ? 'Copy: Raw' : 'Copy: Rich';
copyToggle.title = copyModeRaw ? 'Copy mode: Raw Markdown' : 'Copy mode: Rendered';
document.body.appendChild(copyToggle);

copyToggle.addEventListener('click', () => {
  copyModeRaw = !copyModeRaw;
  setCopyMode(copyModeRaw);
  copyToggle.textContent = copyModeRaw ? 'Copy: Raw' : 'Copy: Rich';
  copyToggle.title = copyModeRaw ? 'Copy mode: Raw Markdown' : 'Copy mode: Rendered';
});

// Comment system
const pendingStore = new PendingCommentStore(vscode);
const commentToggle = new CommentToggle(editor, vscode, pendingStore);
const llmStore = new LlmCommentStore();
const commentPanel = new CommentPanel(
  editorElement, pendingStore, vscode, llmStore, editor,
  () => workspaceRelativePath,
  () => llmLineMap,
  () => rawMarkdown,
);

// Register ProseMirror plugin for comment indicators
const commentPlugin = createCommentIndicatorPlugin();
editor.registerPlugin(commentPlugin);

// LLM-Assist mount. The rebuildLlmLineMap closure captures `editor` + the
// markdown-it parser so LlmToggle can republish plugin state without
// re-deriving these at activate time.
//
// rawMarkdown tracks the file content as it exists on disk so that line
// numbers in the copy payload match the raw .md file (what an LLM reads).
// It is set from the init/externalUpdate message and updated to the
// serialised version after each user edit.
let llmLineMap: LineMap | null = null;
let rawMarkdown = '';
let workspaceRelativePath = '';
let lastKnownSerialized = '';
let isExternallyUpdating = false;
const rebuildLlmLineMap = (): void => {
  const md = (editor.storage as any).markdown?.parser?.md;
  llmLineMap = md ? buildLineMap(editor.state.doc, rawMarkdown, md) : null;
};

const llmSelectionAnchor = new LlmSelectionAnchor(
  editor,
  llmStore,
  commentPanel,
  editorElement,
  () => llmLineMap,
);

const llmToggle = new LlmToggle(
  editor,
  vscode,
  llmStore,
  commentPanel,
  commentToggle,
  llmSelectionAnchor,
  (patch) => {
    const current = getCommentIndicatorState(editor.view);
    updateCommentIndicatorState(editor.view, {
      ...current,
      llmAssistActive: patch.llmAssistActive ?? current.llmAssistActive ?? false,
      llmComments: (patch.llmComments as any) ?? current.llmComments ?? [],
      lineMap: llmLineMap ?? current.lineMap,
    });
  },
  rebuildLlmLineMap,
  () => llmLineMap,
  () => rawMarkdown,
);

// Assemble the right-side toolbar as a connected button group.
// Buttons are collected after all constructors have appended them to body.
const toolbarRight = document.createElement('div');
toolbarRight.id = 'toolbar-right';
['.llm-toggle', '.review-toggle', '.copy-mode-toggle', '.code-wrap-toggle'].forEach(sel => {
  const el = document.querySelector(sel);
  if (el) toolbarRight.appendChild(el);
});
document.body.appendChild(toolbarRight);

llmStore.onChange(() => {
  if (!llmToggle.isActive()) return;
  const current = getCommentIndicatorState(editor.view);
  updateCommentIndicatorState(editor.view, {
    ...current,
    llmComments: llmStore.getAll(),
  });
});

// Track last received threads for badge click lookups
let lastThreads: CommentThread[] = [];

// Clear decorations when review mode is toggled OFF
commentToggle.onDeactivate(() => {
  updateCommentIndicatorState(editor.view, {
    reviewMode: false,
    diffHighlightLines: [],
    threads: [],
    pendingComments: [],
    lineMap: null,
  });
  lastThreads = [];
  commentPanel.close();
});

// Subscribe to pending store changes to keep indicator plugin in sync
pendingStore.onChange(() => {
  const currentState = getCommentIndicatorState(editor.view);
  if (!currentState.reviewMode) return;
  updateCommentIndicatorState(editor.view, {
    ...currentState,
    pendingComments: pendingStore.getAll(),
  });
});

// Wire badge click events to open comment panel
document.addEventListener('comment-badge-click', ((e: CustomEvent) => {
  const { threadId, line } = e.detail as { threadId: number; line: number };
  const thread = lastThreads.find(t => t.id === threadId);
  if (!thread) return;

  const badge = document.querySelector(`.comment-badge[data-line="${line}"]`) as HTMLElement | null;
  if (!badge) return;
  commentPanel.openThread(thread, badge);
}) as EventListener);

// Unified "+" comment button: floating button that appears on selection (single or multi-line)
// and falls back to per-line ::after hover when no selection is active.
const selectionBtn = document.createElement('button');
selectionBtn.className = 'selection-comment-btn';
selectionBtn.textContent = '+';
selectionBtn.title = 'Add comment';
selectionBtn.style.display = 'none';
document.body.appendChild(selectionBtn);

let selectionStartLine: number | null = null;
let selectionEndLine: number | null = null;
let selectionAnchor: HTMLElement | null = null;

function updateSelectionButton(): void {
  const state = getCommentIndicatorState(editor.view);
  if (!state.reviewMode) {
    selectionBtn.style.display = 'none';
    editorElement?.classList.remove('has-selection');
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionBtn.style.display = 'none';
    editorElement?.classList.remove('has-selection');
    return;
  }

  // Find all diff-highlighted blocks that overlap with the selection
  const range = sel.getRangeAt(0);
  const highlights = editorElement!.querySelectorAll('.diff-highlight[data-diff-line]');
  const selectedLines: { line: number; el: HTMLElement }[] = [];

  for (const el of Array.from(highlights) as HTMLElement[]) {
    if (range.intersectsNode(el)) {
      const line = Number(el.dataset.diffLine);
      if (!isNaN(line)) selectedLines.push({ line, el });
    }
  }

  if (selectedLines.length === 0) {
    selectionBtn.style.display = 'none';
    editorElement?.classList.remove('has-selection');
    return;
  }

  // Sort by line number
  selectedLines.sort((a, b) => a.line - b.line);

  if (selectedLines.length === 1) {
    // Single line selected — no startLine
    selectionStartLine = null;
    selectionEndLine = selectedLines[0].line;
    selectionAnchor = selectedLines[0].el;
  } else {
    // Multi-line — both start and end
    selectionStartLine = selectedLines[0].line;
    selectionEndLine = selectedLines[selectedLines.length - 1].line;
    selectionAnchor = selectedLines[selectedLines.length - 1].el;
  }

  // Hide per-line ::after buttons, show floating button
  editorElement?.classList.add('has-selection');
  const anchorRect = selectionAnchor.getBoundingClientRect();
  selectionBtn.style.display = 'flex';
  selectionBtn.style.top = `${anchorRect.top + anchorRect.height / 2 - 13}px`;
  selectionBtn.style.left = `${anchorRect.right - 36}px`;
}

document.addEventListener('selectionchange', updateSelectionButton);

selectionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  if (selectionEndLine !== null && selectionAnchor) {
    commentPanel.openNew(selectionEndLine, selectionStartLine, selectionAnchor);
    selectionBtn.style.display = 'none';
    editorElement?.classList.remove('has-selection');
    window.getSelection()?.removeAllRanges();
  }
});

// Fallback: per-line ::after click (only when no selection is active)
editorElement?.addEventListener('click', (e: MouseEvent) => {
  if (selectionBtn.style.display !== 'none') return;
  const state = getCommentIndicatorState(editor.view);
  if (!state.reviewMode) return;

  const target = e.target as HTMLElement;

  // Check if clicking a pending comment badge → open panel to view pending comments
  const pendingLine = target.closest('.comment-highlight-pending[data-pending-line]') as HTMLElement | null;
  if (pendingLine) {
    const rect = pendingLine.getBoundingClientRect();
    if (e.clientX >= rect.right - 50) {
      const line = Number(pendingLine.dataset.pendingLine);
      const startLine = pendingLine.dataset.pendingStartLine
        ? Number(pendingLine.dataset.pendingStartLine)
        : null;
      if (!isNaN(line)) {
        e.stopPropagation();
        e.preventDefault();
        commentPanel.openNew(line, startLine, pendingLine);
        return;
      }
    }
  }

  // Check if clicking an existing thread badge → open thread panel
  const threadLine = target.closest('.comment-highlight[data-thread-id]') as HTMLElement | null;
  if (threadLine) {
    const rect = threadLine.getBoundingClientRect();
    if (e.clientX >= rect.right - 60) {
      const threadId = Number(threadLine.dataset.threadId);
      const thread = lastThreads.find(t => t.id === threadId);
      if (thread) {
        e.stopPropagation();
        e.preventDefault();
        commentPanel.openThread(thread, threadLine);
        return;
      }
    }
  }

  // Otherwise: "+" button on diff-highlighted lines (no existing comment or pending)
  const diffLine = target.closest('.diff-highlight') as HTMLElement | null;
  if (!diffLine) return;
  if (diffLine.dataset.pendingCount || diffLine.dataset.commentCount) return;

  const rect = diffLine.getBoundingClientRect();
  if (e.clientX < rect.right - 38) return;

  const lineNum = diffLine.dataset.diffLine;
  if (!lineNum) return;

  e.stopPropagation();
  e.preventDefault();
  commentPanel.openNew(Number(lineNum), null, diffLine);
});

// LLM-Assist click handler — runs on the same editor element but short-circuits
// when LLM mode is inactive. Kept in its own listener so the review-mode handler
// above stays unchanged.
editorElement?.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  // Per-line "+" button on a fresh commentable line (no comment yet).
  // The + is a CSS ::after at right: 8px, 22 px wide — treat the rightmost 38 px
  // as the click zone, matching the review-mode threshold.
  if (llmToggle.isActive()) {
    const commentableLine = target.closest('.llm-line-commentable[data-llm-line]') as HTMLElement | null;
    if (commentableLine) {
      const rect = commentableLine.getBoundingClientRect();
      if (e.clientX >= rect.right - 38) {
        const line1 = Number(commentableLine.getAttribute('data-llm-line'));
        if (!isNaN(line1)) {
          e.stopPropagation();
          e.preventDefault();
          commentPanel.openLlmLine(line1, commentableLine);
          return;
        }
      }
    }
  }

  if (dispatchLlmEditorClick(target, llmToggle, llmStore, commentPanel)) {
    e.stopPropagation();
    e.preventDefault();
  }
});

// Keep rawMarkdown in sync with user edits so the lineMap reflects what is
// on disk. Mark-only changes (e.g. LLM comment highlights) change the
// ProseMirror doc object but produce identical serialised markdown, so
// comparing doc references is insufficient. Instead, compare the serialised
// output — only overwrite rawMarkdown when text content actually changed.
editor.on('update', () => {
  if (!isExternallyUpdating) {
    const serialized = unescapeInlineCode(editor.storage.markdown.getMarkdown());
    if (serialized !== lastKnownSerialized) {
      rawMarkdown = serialized;
      lastKnownSerialized = serialized;
    }
  }
});

syncClient.init();
