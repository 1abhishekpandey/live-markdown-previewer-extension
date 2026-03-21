import type { Editor } from '@tiptap/core';
import type { PendingCommentStore } from './pendingCommentStore';
import type { CommentDataMessage, ReviewSubmitResultMessage, CommentErrorMessage } from '../sync/syncProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

export class CommentToggle {
  private editor: Editor;
  private vscode: VsCodeApi;
  private store: PendingCommentStore;

  private reviewActive = false;
  private prNumber: number | null = null;
  private prUrl: string | null = null;
  private lastFetchedAt: number | null = null;
  private stalenessInterval: ReturnType<typeof setInterval> | null = null;
  private submitState: 'idle' | 'confirming' | 'loading' | 'success' | 'error' = 'idle';

  // DOM elements
  private toggleBtn: HTMLButtonElement;
  private refreshBtn: HTMLButtonElement;
  private submitBtn: HTMLButtonElement;
  private stalenessEl: HTMLSpanElement;
  private unsubscribe: (() => void) | null = null;

  constructor(editor: Editor, vscode: VsCodeApi, store: PendingCommentStore) {
    this.editor = editor;
    this.vscode = vscode;
    this.store = store;

    // Create toggle button
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'review-toggle';
    this.toggleBtn.textContent = 'Review';
    this.toggleBtn.addEventListener('click', () => this.onToggleClick());
    document.body.appendChild(this.toggleBtn);

    // Create refresh button (hidden by default)
    this.refreshBtn = document.createElement('button');
    this.refreshBtn.className = 'review-refresh';
    this.refreshBtn.textContent = 'Refresh';
    this.refreshBtn.style.display = 'none';
    this.refreshBtn.addEventListener('click', () => this.onRefreshClick());
    document.body.appendChild(this.refreshBtn);

    // Create submit button (hidden by default)
    this.submitBtn = document.createElement('button');
    this.submitBtn.className = 'review-submit';
    this.submitBtn.style.display = 'none';
    this.submitBtn.addEventListener('click', () => this.onSubmitClick());
    document.body.appendChild(this.submitBtn);

    // Staleness indicator (hidden by default)
    this.stalenessEl = document.createElement('span');
    this.stalenessEl.className = 'review-staleness';
    this.stalenessEl.style.display = 'none';
    document.body.appendChild(this.stalenessEl);

    // Subscribe to pending count changes
    this.unsubscribe = this.store.onChange(() => this.updateSubmitButton());

    // In review mode, intercept mousedown on table cells in the capture phase
    // BEFORE ProseMirror's tableEditing plugin can create a CellSelection.
    // This allows native browser text selection across table rows.
    const editorParent = this.editor.view.dom.parentElement;
    if (editorParent) {
      editorParent.addEventListener('mousedown', (e: MouseEvent) => {
        if (!this.reviewActive) return;
        const target = e.target as HTMLElement;
        if (target.closest('td, th')) {
          e.stopPropagation();
        }
      }, true);
    }
  }

  private onToggleClick(): void {
    if (this.reviewActive) {
      // Toggle OFF
      this.reviewActive = false;
      this.vscode.postMessage({ type: 'commentToggle', enabled: false });
      this.editor.setEditable(true);
      this.cleanup();
    } else {
      // Toggle ON — request from extension
      this.toggleBtn.classList.add('loading');
      this.vscode.postMessage({ type: 'commentToggle', enabled: true });
    }
  }

  private onRefreshClick(): void {
    this.refreshBtn.classList.add('loading');
    this.vscode.postMessage({ type: 'commentRefresh' });
  }

  private onSubmitClick(): void {
    if (this.submitState === 'idle') {
      this.submitState = 'confirming';
      this.submitBtn.textContent = `Submit ${this.store.getCount()} comments to PR #${this.prNumber}?`;
      this.submitBtn.dataset.confirming = 'true';
    } else if (this.submitState === 'confirming') {
      // Confirm click
      this.submitState = 'loading';
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = 'Submitting...';
      this.vscode.postMessage({ type: 'submitReview', pending: this.store.getAll() });
    }
  }

  cancelSubmit(): void {
    this.submitState = 'idle';
    this.updateSubmitButton();
  }

  /** Called when extension sends commentData (toggle ON success or refresh) */
  handleCommentData(msg: CommentDataMessage): void {
    this.reviewActive = true;
    this.prNumber = msg.prNumber;
    this.prUrl = msg.prUrl;
    this.lastFetchedAt = msg.lastFetchedAt;

    // Update toggle button
    this.toggleBtn.classList.remove('loading');
    this.toggleBtn.textContent = '';
    this.toggleBtn.appendChild(document.createTextNode('Review: ON  '));
    const badge = document.createElement('span');
    badge.className = 'review-pr-badge';
    badge.textContent = `PR #${msg.prNumber}`;
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.vscode.postMessage({ type: 'commentOpenPr' });
    });
    this.toggleBtn.appendChild(badge);

    // Set editor read-only (table cell selection already handled by capture-phase handler)
    this.editor.setEditable(false);

    // Show refresh + staleness
    this.refreshBtn.style.display = '';
    this.refreshBtn.classList.remove('loading');
    this.stalenessEl.style.display = '';
    this.updateStaleness();
    this.startStalenessTimer();

    // Update submit button
    this.updateSubmitButton();
  }

  /** Called when extension sends reviewSubmitResult */
  handleSubmitResult(msg: ReviewSubmitResultMessage): void {
    this.submitBtn.disabled = false;
    if (msg.success) {
      this.submitState = 'success';
      this.submitBtn.textContent = '✓ Submitted';
      setTimeout(() => {
        this.submitState = 'idle';
        this.updateSubmitButton();
      }, 2000);
    } else {
      this.submitState = 'error';
      this.submitBtn.textContent = `✗ ${msg.error || 'Failed'}`;
      setTimeout(() => {
        this.submitState = 'idle';
        this.updateSubmitButton();
      }, 3000);
    }
  }

  /** Called when extension sends commentError */
  handleError(msg: CommentErrorMessage): void {
    this.toggleBtn.classList.remove('loading');
    this.toggleBtn.title = msg.message;
    // Show error tooltip for 5 seconds
    this.toggleBtn.classList.add('error');
    setTimeout(() => {
      this.toggleBtn.classList.remove('error');
      this.toggleBtn.title = '';
    }, 5000);
  }

  isActive(): boolean {
    return this.reviewActive;
  }

  private updateSubmitButton(): void {
    const count = this.store.getCount();
    if (!this.reviewActive || count === 0) {
      this.submitBtn.style.display = 'none';
      return;
    }
    this.submitBtn.style.display = '';
    if (this.submitState === 'idle') {
      this.submitBtn.textContent = `Submit Review (${count})`;
      this.submitBtn.disabled = false;
      delete this.submitBtn.dataset.confirming;
    }
  }

  private updateStaleness(): void {
    if (!this.lastFetchedAt) return;
    const elapsed = Date.now() - this.lastFetchedAt;
    const minutes = Math.floor(elapsed / 60000);

    if (elapsed >= 3600000) {
      // 1-hour TTL expired
      this.stalenessEl.textContent = 'Comments expired — toggle review to refresh';
      return;
    }

    this.stalenessEl.textContent = minutes < 1
      ? 'Last refreshed just now'
      : `Last refreshed ${minutes} min ago`;
  }

  private startStalenessTimer(): void {
    this.stopStalenessTimer();
    this.stalenessInterval = setInterval(() => this.updateStaleness(), 60000);
  }

  private stopStalenessTimer(): void {
    if (this.stalenessInterval) {
      clearInterval(this.stalenessInterval);
      this.stalenessInterval = null;
    }
  }

  private cleanup(): void {
    this.stopStalenessTimer();
    this.toggleBtn.textContent = 'Review';
    this.toggleBtn.classList.remove('loading', 'error');
    this.refreshBtn.style.display = 'none';
    this.submitBtn.style.display = 'none';
    this.stalenessEl.style.display = 'none';
    this.prNumber = null;
    this.prUrl = null;
    this.lastFetchedAt = null;
    this.submitState = 'idle';
  }

  dispose(): void {
    this.cleanup();
    if (this.unsubscribe) this.unsubscribe();
  }
}
