import './styles.css';
import { createEditor } from './editor';
import { SyncClient } from './syncClient';
import { setCopyMode } from './copyToolbar';
import { PendingCommentStore } from './pendingCommentStore';
import { CommentToggle } from './commentToggle';
import { CommentPanel } from './commentPanel';
import { createCommentIndicatorPlugin, updateCommentIndicatorState, getCommentIndicatorState } from './commentIndicator';
import { buildLineMap } from './lineMap';
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

  // Comment system message routing
  if (data.type === 'commentData') {
    const msg = data as CommentDataMessage;
    commentToggle.handleCommentData(msg);
    lastThreads = msg.threads;

    // Build line map for position lookups
    const md = (editor.storage as any).markdown?.parser?.md;
    const markdown = editor.storage.markdown.getMarkdown();
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
const commentPanel = new CommentPanel(editorElement, pendingStore, vscode);

// Register ProseMirror plugin for comment indicators
const commentPlugin = createCommentIndicatorPlugin();
editor.registerPlugin(commentPlugin);

// Track last received threads for badge click lookups
let lastThreads: CommentThread[] = [];

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

  // Find the anchor element (the badge that was clicked)
  const badge = document.querySelector(`.comment-badge[data-line="${line}"]`) as HTMLElement | null;
  if (!badge) return;
  commentPanel.openThread(thread, badge);
}) as EventListener);

syncClient.init();
