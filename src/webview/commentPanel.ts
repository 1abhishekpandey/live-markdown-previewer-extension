import type { CommentThread, CommentData, PendingComment } from '../sync/commentTypes';
import type { PendingCommentStore } from './pendingCommentStore';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

export class CommentPanel {
  private container: HTMLElement;
  private store: PendingCommentStore;
  private vscode: VsCodeApi;
  private panelEl: HTMLElement | null = null;
  private currentThreadId: number | null = null;
  private currentLine: number | null = null;
  private currentStartLine: number | null = null;
  private closeHandlers: (() => void)[] = [];
  private storeUnsubscribe: (() => void) | null = null;

  constructor(container: HTMLElement, store: PendingCommentStore, vscode: VsCodeApi) {
    this.container = container;
    this.store = store;
    this.vscode = vscode;
  }

  /** Open panel for an existing comment thread */
  openThread(thread: CommentThread, anchorEl: HTMLElement): void {
    this.close();
    this.currentThreadId = thread.id;
    this.currentLine = thread.workingCopyLine;
    this.currentStartLine = thread.workingCopyStartLine;

    const pending = this.store.getAll().filter(
      p => p.workingCopyLine === thread.workingCopyLine
    );

    this.panelEl = this.buildPanel({
      headerText: this.formatLineHeader(thread.workingCopyLine, thread.workingCopyStartLine),
      commentCount: thread.comments.length + pending.length,
      comments: thread.comments,
      pendingComments: pending,
      isNewComment: false,
      threadId: thread.id,
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToStore();
  }

  /** Open panel for a new comment on a line */
  openNew(line: number, startLine: number | null, anchorEl: HTMLElement): void {
    this.close();
    this.currentThreadId = null;
    this.currentLine = line;
    this.currentStartLine = startLine;

    const pending = this.store.getAll().filter(
      p => p.workingCopyLine === line
    );

    this.panelEl = this.buildPanel({
      headerText: this.formatLineHeader(line, startLine, true),
      commentCount: pending.length,
      comments: [],
      pendingComments: pending,
      isNewComment: true,
      threadId: null,
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToStore();
  }

  close(): void {
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.currentThreadId = null;
    this.currentLine = null;
    this.currentStartLine = null;
    for (const cleanup of this.closeHandlers) cleanup();
    this.closeHandlers = [];
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
  }

  isOpen(): boolean {
    return this.panelEl !== null;
  }

  /** Refresh panel contents with updated data */
  refresh(threads: CommentThread[], pendingComments: PendingComment[]): void {
    if (!this.panelEl || this.currentLine === null) return;
    // Preserve textarea text
    const textarea = this.panelEl.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
    const savedText = textarea?.value ?? '';

    const thread = this.currentThreadId
      ? threads.find(t => t.id === this.currentThreadId)
      : null;
    const pending = pendingComments.filter(p => p.workingCopyLine === this.currentLine);

    const body = this.panelEl.querySelector('.comment-panel-body');
    if (body) {
      body.innerHTML = '';
      if (thread) {
        for (const c of thread.comments) {
          body.appendChild(this.renderComment(c));
        }
      }
      for (const p of pending) {
        body.appendChild(this.renderPendingComment(p));
      }
    }

    // Restore textarea
    const newTextarea = this.panelEl.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
    if (newTextarea && savedText) {
      newTextarea.value = savedText;
    }
  }

  private buildPanel(opts: {
    headerText: string;
    commentCount: number;
    comments: CommentData[];
    pendingComments: PendingComment[];
    isNewComment: boolean;
    threadId: number | null;
  }): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'comment-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'comment-panel-header';

    const lineSpan = document.createElement('span');
    lineSpan.className = 'comment-panel-line';
    lineSpan.textContent = opts.headerText;
    header.appendChild(lineSpan);

    if (opts.commentCount > 0) {
      const countSpan = document.createElement('span');
      countSpan.className = 'comment-panel-count';
      countSpan.textContent = `${opts.commentCount} comment${opts.commentCount !== 1 ? 's' : ''}`;
      header.appendChild(countSpan);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'comment-panel-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Body (scrollable)
    const body = document.createElement('div');
    body.className = 'comment-panel-body';

    for (const comment of opts.comments) {
      body.appendChild(this.renderComment(comment));
    }
    for (const pending of opts.pendingComments) {
      body.appendChild(this.renderPendingComment(pending));
    }

    panel.appendChild(body);

    // Reply section
    const replySection = document.createElement('div');
    replySection.className = 'comment-panel-reply';

    const textarea = document.createElement('textarea');
    textarea.className = 'comment-reply-input';
    textarea.placeholder = 'Type a reply...';
    replySection.appendChild(textarea);

    const queueBtn = document.createElement('button');
    queueBtn.className = 'comment-reply-queue';
    queueBtn.textContent = 'Queue';
    queueBtn.addEventListener('click', () => this.onQueueClick(textarea, opts.threadId));
    replySection.appendChild(queueBtn);

    panel.appendChild(replySection);

    return panel;
  }

  private renderComment(comment: CommentData): HTMLElement {
    const entry = document.createElement('div');
    entry.className = comment.isOutdated ? 'comment-entry comment-entry-outdated' : 'comment-entry';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = `@${comment.author}`;
    meta.appendChild(author);

    const time = document.createElement('span');
    time.className = 'comment-timestamp';
    time.textContent = this.formatRelativeTime(comment.createdAt);
    meta.appendChild(time);

    if (comment.isOutdated) {
      const outdated = document.createElement('span');
      outdated.className = 'comment-outdated-label';
      outdated.textContent = 'Outdated';
      meta.appendChild(outdated);
    }

    entry.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = comment.body;
    entry.appendChild(body);

    return entry;
  }

  private renderPendingComment(pending: PendingComment): HTMLElement {
    const entry = document.createElement('div');
    entry.className = 'comment-entry comment-entry-pending';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    const label = document.createElement('span');
    label.className = 'comment-pending-label';
    label.textContent = 'Pending';
    meta.appendChild(label);

    const discardBtn = document.createElement('button');
    discardBtn.className = 'comment-discard';
    discardBtn.textContent = '\u00d7';
    discardBtn.addEventListener('click', () => {
      this.store.remove(pending.tempId);
    });
    meta.appendChild(discardBtn);

    entry.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = pending.body;
    entry.appendChild(body);

    return entry;
  }

  private onQueueClick(textarea: HTMLTextAreaElement, threadId: number | null): void {
    const body = textarea.value.trim();
    if (!body) return;

    const tempId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const line = this.currentLine!;
    const startLine = this.currentStartLine;

    // Send validation request to extension
    this.vscode.postMessage({
      type: 'validateLine',
      tempId,
      workingCopyLine: line,
      workingCopyStartLine: startLine,
    });

    // Store the pending comment optimistically (will be validated by extension response)
    const comment: PendingComment = {
      tempId,
      threadId,
      body,
      workingCopyLine: line,
      workingCopyStartLine: startLine,
      diffLine: null, // filled by validation response
      diffStartLine: null,
    };
    this.store.add(comment);
    textarea.value = '';
  }

  private positionPanel(anchorEl: HTMLElement): void {
    if (!this.panelEl) return;
    const rect = anchorEl.getBoundingClientRect();
    this.panelEl.style.position = 'absolute';
    this.panelEl.style.top = `${rect.top + window.scrollY}px`;
    this.panelEl.style.left = `${rect.right + 16}px`;
  }

  private registerCloseHandlers(): void {
    // Escape key
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const textarea = this.panelEl?.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
        if (textarea && document.activeElement === textarea && textarea.value.trim()) return;
        this.close();
      }
    };
    document.addEventListener('keydown', keyHandler);
    this.closeHandlers.push(() => document.removeEventListener('keydown', keyHandler));

    // Click outside (with frame delay to prevent immediate close)
    requestAnimationFrame(() => {
      const clickHandler = (e: MouseEvent) => {
        if (this.panelEl && !this.panelEl.contains(e.target as Node)) {
          this.close();
        }
      };
      document.addEventListener('mousedown', clickHandler);
      this.closeHandlers.push(() => document.removeEventListener('mousedown', clickHandler));
    });
  }

  private subscribeToStore(): void {
    this.storeUnsubscribe = this.store.onChange(() => {
      if (!this.panelEl || this.currentLine === null) return;
      // Re-render pending comments in the panel
      const body = this.panelEl.querySelector('.comment-panel-body');
      if (!body) return;
      // Remove existing pending entries and re-add
      body.querySelectorAll('.comment-entry-pending').forEach(el => el.remove());
      const pending = this.store.getAll().filter(p => p.workingCopyLine === this.currentLine);
      for (const p of pending) {
        body.appendChild(this.renderPendingComment(p));
      }
    });
  }

  private formatLineHeader(line: number, startLine: number | null, isNew = false): string {
    const prefix = isNew ? 'New comment on ' : '';
    if (startLine !== null && startLine !== line) {
      return `${prefix}Lines ${startLine}-${line}`;
    }
    return `${prefix}Line ${line}`;
  }

  private formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  dispose(): void {
    this.close();
  }
}
