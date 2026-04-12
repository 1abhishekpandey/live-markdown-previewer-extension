import type { Editor } from '@tiptap/core';
import type { CommentThread, CommentData, PendingComment } from '../sync/commentTypes';
import type { PendingCommentStore } from './pendingCommentStore';
import type { LlmComment, LlmCommentStore } from './llmCommentStore';
import { updateCommentIndicatorState, getCommentIndicatorState } from './commentIndicator';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

type PanelMode = 'thread' | 'llm-assist';
type LlmMode = 'line' | 'text' | 'newText';

interface PendingLlmCreation {
  commentId: string;
  kind: 'text';
  startLine: number;
  endLine: number;
  createdAt: number;
}

export class CommentPanel {
  private container: HTMLElement;
  private store: PendingCommentStore;
  private vscode: VsCodeApi;
  private llmStore: LlmCommentStore | null;
  private editor: Editor | null;
  private panelEl: HTMLElement | null = null;
  private currentThreadId: number | null = null;
  private currentLine: number | null = null;
  private currentStartLine: number | null = null;
  private currentLlmMode: LlmMode | null = null;
  private currentLlmCommentId: string | null = null;
  private pendingLlmCreation: PendingLlmCreation | null = null;
  private closeHandlers: (() => void)[] = [];
  private storeUnsubscribe: (() => void) | null = null;
  private llmStoreUnsubscribe: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    store: PendingCommentStore,
    vscode: VsCodeApi,
    llmStore: LlmCommentStore | null = null,
    editor: Editor | null = null,
  ) {
    this.container = container;
    this.store = store;
    this.vscode = vscode;
    this.llmStore = llmStore;
    this.editor = editor;
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
      mode: 'thread',
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
      mode: 'thread',
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToStore();
  }

  /** Open LLM-Assist panel for a line (line-level comment). */
  openLlmLine(line1: number, anchorEl: HTMLElement): void {
    if (!this.llmStore) return;
    this.close();
    this.currentLine = line1;
    this.currentStartLine = line1;
    this.currentLlmMode = 'line';
    this.currentLlmCommentId = null;

    this.panelEl = this.buildPanel({
      headerText: this.formatLineHeader(line1, line1),
      commentCount: this.llmStore.getForLine(line1).length,
      comments: [],
      pendingComments: [],
      isNewComment: false,
      threadId: null,
      mode: 'llm-assist',
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToLlmStore();

    if (this.editor) {
      const current = getCommentIndicatorState(this.editor.view);
      updateCommentIndicatorState(this.editor.view, { ...current, activeLlmLine: line1 });
    }

    if (this.llmStore.getForLine(line1).length === 0) {
      const ta = this.panelEl.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
      ta?.focus();
    }
  }

  /** Open LLM-Assist panel for an existing text-level comment (edit flow). */
  openLlmText(id: string, anchorEl: HTMLElement): void {
    if (!this.llmStore) return;
    const entry = this.llmStore.get(id);
    if (!entry) return;
    this.close();
    this.currentLine = entry.startLine;
    this.currentStartLine = entry.startLine;
    this.currentLlmMode = 'text';
    this.currentLlmCommentId = id;

    const headerText =
      entry.endLine !== entry.startLine
        ? this.formatLineHeader(entry.endLine, entry.startLine)
        : this.formatLineHeader(entry.startLine, entry.startLine);

    this.panelEl = this.buildPanel({
      headerText,
      commentCount: this.llmStore.getForLine(entry.startLine).length,
      comments: [],
      pendingComments: [],
      isNewComment: false,
      threadId: null,
      mode: 'llm-assist',
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToLlmStore();

    const ta = this.panelEl.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
    if (ta) ta.value = entry.body;
  }

  /**
   * Open LLM-Assist panel for a NEW text-level comment. The mark has already been
   * applied to the selection; the user is about to type the body. If they close the
   * panel without saving, the mark must be unwound.
   */
  openLlmNewText(
    commentId: string,
    anchorEl: HTMLElement,
    startLine: number,
    endLine: number,
  ): void {
    if (!this.llmStore) return;
    this.close();
    this.currentLine = startLine;
    this.currentStartLine = startLine;
    this.currentLlmMode = 'newText';
    this.currentLlmCommentId = commentId;
    this.pendingLlmCreation = {
      commentId,
      kind: 'text',
      startLine,
      endLine,
      createdAt: Date.now(),
    };

    const headerText =
      endLine !== startLine
        ? this.formatLineHeader(endLine, startLine)
        : this.formatLineHeader(startLine, startLine);

    this.panelEl = this.buildPanel({
      headerText,
      commentCount: 0,
      comments: [],
      pendingComments: [],
      isNewComment: true,
      threadId: null,
      mode: 'llm-assist',
    });

    this.positionPanel(anchorEl);
    this.container.appendChild(this.panelEl);
    this.registerCloseHandlers();
    this.subscribeToLlmStore();

    const ta = this.panelEl.querySelector('.comment-reply-input') as HTMLTextAreaElement | null;
    ta?.focus();
  }

  close(): void {
    // Clear the active-line highlight when closing a line panel.
    if (this.currentLlmMode === 'line' && this.editor) {
      const current = getCommentIndicatorState(this.editor.view);
      updateCommentIndicatorState(this.editor.view, { ...current, activeLlmLine: null });
    }

    // Unwind a not-yet-saved new-text comment's highlight mark
    if (
      this.currentLlmMode === 'newText' &&
      this.pendingLlmCreation &&
      this.editor
    ) {
      this.editor.commands.unsetLlmCommentById(this.pendingLlmCreation.commentId);
    }

    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.currentThreadId = null;
    this.currentLine = null;
    this.currentStartLine = null;
    this.currentLlmMode = null;
    this.currentLlmCommentId = null;
    this.pendingLlmCreation = null;
    for (const cleanup of this.closeHandlers) cleanup();
    this.closeHandlers = [];
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
    if (this.llmStoreUnsubscribe) {
      this.llmStoreUnsubscribe();
      this.llmStoreUnsubscribe = null;
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
    mode: PanelMode;
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

    if (opts.mode === 'llm-assist') {
      // LLM mode: render entries from llmStore for the current line.
      if (this.llmStore && this.currentLine !== null) {
        for (const entry of this.llmStore.getForLine(this.currentLine)) {
          body.appendChild(this.renderLlmCommentEntry(entry));
        }
      }
    } else {
      for (const comment of opts.comments) {
        body.appendChild(this.renderComment(comment));
      }
      for (const pending of opts.pendingComments) {
        body.appendChild(this.renderPendingComment(pending));
      }
    }

    panel.appendChild(body);

    if (opts.mode === 'llm-assist') {
      // LLM mode always shows the Save input.
      const replySection = document.createElement('div');
      replySection.className = 'comment-panel-reply';

      const textarea = document.createElement('textarea');
      textarea.className = 'comment-reply-input';
      textarea.placeholder = 'Type a comment...';
      replySection.appendChild(textarea);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'comment-reply-queue';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => this.onLlmSaveClick(textarea));
      replySection.appendChild(saveBtn);

      panel.appendChild(replySection);
    } else {
      // Reply section — hidden for new-comment panels that already have a pending comment
      // (only one pending comment per line; replies are only for existing threads)
      const hasPendingAlready = opts.isNewComment && opts.pendingComments.length > 0;
      if (!hasPendingAlready) {
        const replySection = document.createElement('div');
        replySection.className = 'comment-panel-reply';

        const textarea = document.createElement('textarea');
        textarea.className = 'comment-reply-input';
        textarea.placeholder = opts.isNewComment ? 'Type a comment...' : 'Type a reply...';
        replySection.appendChild(textarea);

        const queueBtn = document.createElement('button');
        queueBtn.className = 'comment-reply-queue';
        queueBtn.textContent = 'Queue';
        queueBtn.addEventListener('click', () => this.onQueueClick(textarea, opts.threadId));
        replySection.appendChild(queueBtn);

        panel.appendChild(replySection);
      }
    }

    return panel;
  }

  private renderComment(comment: CommentData): HTMLElement {
    const entry = document.createElement('div');
    let className = 'comment-entry';
    if (comment.isOutdated) className += ' comment-entry-outdated';
    if (comment.isPending) className += ' comment-entry-draft';
    entry.className = className;

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

    if (comment.isPending) {
      const draft = document.createElement('span');
      draft.className = 'comment-draft-label';
      draft.textContent = 'Draft';
      meta.appendChild(draft);
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

    // For new comments (not thread replies), hide the reply section after queuing
    // to prevent adding multiple pending comments on the same line
    if (threadId === null && this.panelEl) {
      const replySection = this.panelEl.querySelector('.comment-panel-reply');
      if (replySection) replySection.remove();
    }
  }

  private onLlmSaveClick(textarea: HTMLTextAreaElement): void {
    if (!this.llmStore) return;
    const body = textarea.value.trim();
    if (!body) return;

    if (this.currentLlmMode === 'newText' && this.pendingLlmCreation) {
      this.llmStore.add({
        id: this.pendingLlmCreation.commentId,
        kind: 'text',
        body,
        createdAt: this.pendingLlmCreation.createdAt,
        startLine: this.pendingLlmCreation.startLine,
        endLine: this.pendingLlmCreation.endLine,
      });
      this.pendingLlmCreation = null;
      this.close();
    } else if (this.currentLlmMode === 'line' && this.currentLine !== null) {
      const line1 = this.currentLine;
      const id = this.makeLlmId();
      this.llmStore.add({
        id,
        kind: 'line',
        body,
        createdAt: Date.now(),
        startLine: line1,
        endLine: line1,
      });
      textarea.value = '';
      // Keep the panel open — the list re-renders via subscribeToLlmStore.
    } else if (this.currentLlmMode === 'text' && this.currentLlmCommentId) {
      this.llmStore.update(this.currentLlmCommentId, body);
      this.close();
    }
  }

  private makeLlmId(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private renderLlmCommentEntry(entry: LlmComment): HTMLElement {
    const el = document.createElement('div');
    el.className = 'comment-entry llm-comment-entry';
    el.setAttribute('data-llm-entry-id', entry.id);

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const kind = document.createElement('span');
    kind.className = 'comment-pending-label';
    kind.textContent = entry.kind === 'line' ? 'Line' : 'Text';
    meta.appendChild(kind);
    el.appendChild(meta);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'comment-body';
    bodyEl.textContent = entry.body;
    el.appendChild(bodyEl);

    const actions = document.createElement('div');
    actions.className = 'llm-entry-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'llm-entry-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => this.startInlineEdit(el, entry));
    actions.appendChild(editBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'llm-entry-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(entry.body).catch(() => {});
      }
    });
    actions.appendChild(copyBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'llm-entry-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!this.llmStore) return;
      this.llmStore.remove(entry.id);
      if (entry.kind === 'text' && this.editor) {
        this.editor.commands.unsetLlmCommentById(entry.id);
      }
    });
    actions.appendChild(deleteBtn);

    el.appendChild(actions);

    return el;
  }

  private startInlineEdit(rowEl: HTMLElement, entry: LlmComment): void {
    if (!this.llmStore) return;
    const bodyEl = rowEl.querySelector('.comment-body') as HTMLElement | null;
    if (!bodyEl) return;
    const oldBody = bodyEl.textContent ?? '';
    const ta = document.createElement('textarea');
    ta.className = 'comment-reply-input llm-entry-edit-input';
    ta.value = oldBody;
    bodyEl.replaceWith(ta);
    ta.focus();

    const confirm = () => {
      const newBody = ta.value.trim();
      if (newBody && newBody !== oldBody && this.llmStore) {
        this.llmStore.update(entry.id, newBody);
      } else {
        const restored = document.createElement('div');
        restored.className = 'comment-body';
        restored.textContent = oldBody;
        ta.replaceWith(restored);
      }
    };

    ta.addEventListener('blur', confirm, { once: true });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const restored = document.createElement('div');
        restored.className = 'comment-body';
        restored.textContent = oldBody;
        ta.replaceWith(restored);
      }
    });
  }

  private subscribeToLlmStore(): void {
    if (!this.llmStore) return;
    this.llmStoreUnsubscribe = this.llmStore.onChange(() => {
      if (!this.panelEl || !this.llmStore || this.currentLine === null) return;
      const body = this.panelEl.querySelector('.comment-panel-body');
      if (!body) return;
      body.innerHTML = '';
      for (const entry of this.llmStore.getForLine(this.currentLine)) {
        body.appendChild(this.renderLlmCommentEntry(entry));
      }
      const countEl = this.panelEl.querySelector('.comment-panel-count');
      const n = this.llmStore.getForLine(this.currentLine).length;
      if (countEl) {
        countEl.textContent = n > 0 ? `${n} comment${n !== 1 ? 's' : ''}` : '';
      }
    });
  }

  private positionPanel(anchorEl: HTMLElement): void {
    if (!this.panelEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const panelWidth = 320; // matches CSS .comment-panel width
    const viewportWidth = window.innerWidth;

    // Position to the right of the editor content, or fall back to right-aligned in viewport
    let left = rect.right + 16;
    if (left + panelWidth > viewportWidth) {
      left = viewportWidth - panelWidth - 16;
    }

    this.panelEl.style.position = 'fixed';
    this.panelEl.style.top = `${Math.max(40, rect.top)}px`;
    this.panelEl.style.left = `${left}px`;
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
      const body = this.panelEl.querySelector('.comment-panel-body');
      if (!body) return;
      // Remove existing pending entries and re-add
      body.querySelectorAll('.comment-entry-pending').forEach(el => el.remove());
      const pending = this.store.getAll().filter(p => p.workingCopyLine === this.currentLine);
      for (const p of pending) {
        body.appendChild(this.renderPendingComment(p));
      }

      // Update comment count in header
      const countEl = this.panelEl.querySelector('.comment-panel-count');
      const totalCount = (this.panelEl.querySelectorAll('.comment-entry:not(.comment-entry-pending)').length) + pending.length;
      if (countEl) {
        countEl.textContent = totalCount > 0 ? `${totalCount} comment${totalCount !== 1 ? 's' : ''}` : '';
      }

      // For new-comment panels: show/hide reply section based on pending count
      if (this.currentThreadId === null) {
        const existingReply = this.panelEl.querySelector('.comment-panel-reply');
        if (pending.length === 0 && !existingReply) {
          // All pending removed → re-add the reply section
          const replySection = document.createElement('div');
          replySection.className = 'comment-panel-reply';

          const textarea = document.createElement('textarea');
          textarea.className = 'comment-reply-input';
          textarea.placeholder = 'Type a comment...';
          replySection.appendChild(textarea);

          const queueBtn = document.createElement('button');
          queueBtn.className = 'comment-reply-queue';
          queueBtn.textContent = 'Queue';
          queueBtn.addEventListener('click', () => this.onQueueClick(textarea, null));
          replySection.appendChild(queueBtn);

          this.panelEl.appendChild(replySection);
        } else if (pending.length > 0 && existingReply) {
          // Pending exists → remove reply section
          existingReply.remove();
        }
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
