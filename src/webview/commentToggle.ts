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
  private prUrl: string | null = null;
  private lastFetchedAt: number | null = null;
  private stalenessInterval: ReturnType<typeof setInterval> | null = null;
  private submitState: 'idle' | 'confirming' | 'loading' | 'success' | 'error' = 'idle';

  private onDeactivateCallback: (() => void) | null = null;

  // DOM elements
  private toggleBtn: HTMLButtonElement;
  private reviewBarEl: HTMLDivElement;
  private prBadgeEl: HTMLSpanElement;
  private refreshBtn: HTMLButtonElement;
  private actionsRow: HTMLDivElement;
  private submitBtn: HTMLButtonElement;
  private discardBtn: HTMLButtonElement;
  private stalenessEl: HTMLSpanElement;
  private unsubscribe: (() => void) | null = null;

  constructor(editor: Editor, vscode: VsCodeApi, store: PendingCommentStore) {
    this.editor = editor;
    this.vscode = vscode;
    this.store = store;

    // Row 1: toggle button (always visible)
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'review-toggle';
    this.toggleBtn.textContent = 'Review: Off';
    this.toggleBtn.addEventListener('click', () => this.onToggleClick());
    document.body.appendChild(this.toggleBtn);

    // Row 2 container (hidden when review OFF)
    this.reviewBarEl = document.createElement('div');
    this.reviewBarEl.className = 'review-bar';
    this.reviewBarEl.style.display = 'none';

    // Line 1: PR badge (clickable → opens PR on GitHub)
    this.prBadgeEl = document.createElement('span');
    this.prBadgeEl.className = 'review-pr-badge';
    this.prBadgeEl.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'commentOpenPr' });
    });
    this.reviewBarEl.appendChild(this.prBadgeEl);

    // Line 2: Refresh + staleness
    const refreshRow = document.createElement('div');
    refreshRow.className = 'review-refresh-row';

    this.refreshBtn = document.createElement('button');
    this.refreshBtn.className = 'review-refresh';
    this.refreshBtn.textContent = 'Refresh ↻';
    this.refreshBtn.title = 'Refresh comments';
    this.refreshBtn.addEventListener('click', () => this.onRefreshClick());
    refreshRow.appendChild(this.refreshBtn);

    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.opacity = '0.5';
    refreshRow.appendChild(sep);

    this.stalenessEl = document.createElement('span');
    this.stalenessEl.className = 'review-staleness';
    refreshRow.appendChild(this.stalenessEl);

    this.reviewBarEl.appendChild(refreshRow);

    // Actions row: Submit + Discard (appears when pending comments exist)
    this.actionsRow = document.createElement('div');
    this.actionsRow.className = 'review-actions-row';
    this.actionsRow.style.display = 'none';

    this.submitBtn = document.createElement('button');
    this.submitBtn.className = 'review-submit';
    this.submitBtn.addEventListener('click', () => this.onSubmitClick());
    this.actionsRow.appendChild(this.submitBtn);

    this.discardBtn = document.createElement('button');
    this.discardBtn.className = 'review-discard';
    this.discardBtn.textContent = 'Discard All';
    this.discardBtn.addEventListener('click', () => this.onDiscardClick());
    this.actionsRow.appendChild(this.discardBtn);

    this.reviewBarEl.appendChild(this.actionsRow);

    document.body.appendChild(this.reviewBarEl);

    // Subscribe to pending count changes
    this.unsubscribe = this.store.onChange(() => this.updateSubmitButton());

    // Intercept mousedown on table cells in the capture phase BEFORE
    // ProseMirror's tableEditing plugin can create a CellSelection.
    // This allows native browser text selection across table rows
    // in both normal and review modes.
    const editorParent = this.editor.view.dom.parentElement;
    if (editorParent) {
      editorParent.addEventListener('mousedown', (e: MouseEvent) => {
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
      this.editor.setEditable(true, false);
      this.cleanup();
      if (this.onDeactivateCallback) this.onDeactivateCallback();
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
    if (this.submitState !== 'idle') return;
    this.submitState = 'loading';
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = 'Submitting...';
    this.vscode.postMessage({ type: 'submitReview', pending: this.store.getAll() });
  }

  cancelSubmit(): void {
    this.submitState = 'idle';
    this.updateSubmitButton();
  }

  /** Called when extension sends commentData (toggle ON success or refresh) */
  handleCommentData(msg: CommentDataMessage): void {
    this.reviewActive = true;

    this.prUrl = msg.prUrl;
    this.lastFetchedAt = msg.lastFetchedAt;

    // Update toggle button
    this.toggleBtn.classList.remove('loading');
    this.toggleBtn.textContent = 'Review: On';

    // Set editor read-only
    this.editor.setEditable(false, false);

    // Show review bar (row 2)
    this.prBadgeEl.textContent = `PR #${msg.prNumber}`;
    this.refreshBtn.classList.remove('loading');
    this.reviewBarEl.style.display = '';
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

  onDeactivate(callback: () => void): void {
    this.onDeactivateCallback = callback;
  }

  private onDiscardClick(): void {
    if (this.store.getCount() === 0) return;
    this.store.clear();
  }

  private updateSubmitButton(): void {
    const count = this.store.getCount();
    if (!this.reviewActive || count === 0) {
      this.actionsRow.style.display = 'none';
      return;
    }
    this.actionsRow.style.display = '';
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
      ? 'just now'
      : `${minutes} min ago`;
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
    this.toggleBtn.textContent = 'Review: Off';
    this.toggleBtn.classList.remove('loading', 'error');
    this.reviewBarEl.style.display = 'none';
    this.actionsRow.style.display = 'none';
    this.prUrl = null;
    this.lastFetchedAt = null;
    this.submitState = 'idle';
  }

  dispose(): void {
    this.cleanup();
    if (this.unsubscribe) this.unsubscribe();
  }
}
