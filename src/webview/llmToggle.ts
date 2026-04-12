import type { Editor } from '@tiptap/core';
import type { LlmCommentStore } from './llmCommentStore';
import type { CommentToggle } from './commentToggle';
import type { CommentPanel } from './commentPanel';
import type { LlmSelectionAnchor } from './llmSelectionAnchor';
import type { LineMap } from './lineMap';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface UpdateIndicatorFn {
  (patch: { llmAssistActive?: boolean; llmComments?: unknown }): void;
}

/**
 * Owns the "LLM-Assist: Off / On" title-bar toggle, the Copy all / Clear all action
 * row, and the activate/deactivate state transitions for LLM-assist mode.
 *
 * LLM-assist and Review mode are mutually exclusive — toggling LLM-assist on
 * while Review is active surfaces an error banner and aborts the activation.
 */
export class LlmToggle {
  private editor: Editor;
  private vscode: VsCodeApi;
  private store: LlmCommentStore;
  private panel: CommentPanel;
  private selectionAnchor: LlmSelectionAnchor;
  private commentToggle: CommentToggle;
  private active = false;
  public workspaceRelativePath = '';

  private updateIndicator: UpdateIndicatorFn;
  private rebuildLineMap: () => void;
  private getLineMap: () => LineMap | null;
  private getRawMarkdown: () => string;
  private docUpdateListener: (() => void) | null = null;
  private storeUnsubscribe: (() => void) | null = null;
  private errorBannerEl: HTMLDivElement;
  private errorBannerTimeout: ReturnType<typeof setTimeout> | null = null;

  // DOM
  private toggleBtn: HTMLButtonElement;
  private barEl: HTMLDivElement;
  private actionsRow: HTMLDivElement;
  private copyAllBtn: HTMLButtonElement;
  private clearAllBtn: HTMLButtonElement;
  private copyLabelTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    editor: Editor,
    vscode: VsCodeApi,
    store: LlmCommentStore,
    panel: CommentPanel,
    commentToggle: CommentToggle,
    selectionAnchor: LlmSelectionAnchor,
    updateIndicator: UpdateIndicatorFn,
    rebuildLineMap: () => void,
    getLineMap: () => LineMap | null = () => null,
    getRawMarkdown: () => string = () => '',
  ) {
    this.editor = editor;
    this.vscode = vscode;
    this.store = store;
    this.panel = panel;
    this.commentToggle = commentToggle;
    this.selectionAnchor = selectionAnchor;
    this.updateIndicator = updateIndicator;
    this.rebuildLineMap = rebuildLineMap;
    this.getLineMap = getLineMap;
    this.getRawMarkdown = getRawMarkdown;

    // Row 1: title-bar toggle (always visible)
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'llm-toggle';
    this.toggleBtn.textContent = 'LLM-Assist: Off';
    this.toggleBtn.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.toggleBtn);

    // Row 2: action row (hidden until a comment exists)
    this.barEl = document.createElement('div');
    this.barEl.className = 'llm-bar';
    this.barEl.style.display = 'none';

    this.actionsRow = document.createElement('div');
    this.actionsRow.className = 'llm-actions-row';

    this.copyAllBtn = document.createElement('button');
    this.copyAllBtn.className = 'llm-copy-all';
    this.copyAllBtn.textContent = 'Copy all (0)';
    this.copyAllBtn.addEventListener('click', () => {
      void this.onCopyAllClick();
    });
    this.actionsRow.appendChild(this.copyAllBtn);

    this.clearAllBtn = document.createElement('button');
    this.clearAllBtn.className = 'llm-clear-all';
    this.clearAllBtn.textContent = 'Clear all (0)';
    this.clearAllBtn.addEventListener('click', () => this.onClearAllClick());
    this.actionsRow.appendChild(this.clearAllBtn);

    this.barEl.appendChild(this.actionsRow);
    document.body.appendChild(this.barEl);

    // Error banner (hidden)
    this.errorBannerEl = document.createElement('div');
    this.errorBannerEl.className = 'llm-error-banner';
    this.errorBannerEl.style.display = 'none';
    document.body.appendChild(this.errorBannerEl);

    // Subscribe to store changes for reactive row-2 labels
    this.storeUnsubscribe = this.store.onChange(() => this.updateActionRow());
    // Initial row-2 state (empty store → hidden)
    this.updateActionRow();
  }

  isActive(): boolean {
    return this.active;
  }

  toggle(): void {
    if (!this.active) {
      // Reject when Review mode is already on.
      if (this.commentToggle.isActive()) {
        this.showErrorBanner('Review mode is active — toggle it off first');
        return;
      }
      this.activate();
    } else {
      this.deactivate();
    }
  }

  private activate(): void {
    this.active = true;
    this.rebuildLineMap();
    this.updateIndicator({ llmAssistActive: true, llmComments: this.store.getAll() });

    // Listen for doc changes to rebuild the line map and republish plugin state
    this.docUpdateListener = () => {
      this.rebuildLineMap();
      this.updateIndicator({ llmAssistActive: true, llmComments: this.store.getAll() });
    };
    this.editor.on('update', this.docUpdateListener);

    this.toggleBtn.textContent = 'LLM-Assist: On';
    this.toggleBtn.classList.add('active');
    this.selectionAnchor.setActive(true);
    // barEl visibility is governed by updateActionRow (N === 0 → hidden).
    this.updateActionRow();
  }

  private deactivate(): void {
    this.active = false;
    this.store.clear();
    (this.editor.commands as unknown as { clearAllLlmComments: () => boolean }).clearAllLlmComments();
    this.updateIndicator({ llmAssistActive: false, llmComments: [] });

    if (this.docUpdateListener) {
      this.editor.off('update', this.docUpdateListener);
      this.docUpdateListener = null;
    }

    this.toggleBtn.textContent = 'LLM-Assist: Off';
    this.toggleBtn.classList.remove('active');
    this.selectionAnchor.setActive(false);
    this.barEl.style.display = 'none';
    // Clear any lingering copy-label timer
    if (this.copyLabelTimeout) {
      clearTimeout(this.copyLabelTimeout);
      this.copyLabelTimeout = null;
    }
  }

  private updateActionRow(): void {
    const n = this.store.getCount();
    this.copyAllBtn.textContent = `Copy all (${n})`;
    this.clearAllBtn.textContent = `Clear all (${n})`;
    if (!this.active || n === 0) {
      this.barEl.style.display = 'none';
    } else {
      this.barEl.style.display = 'flex';
    }
  }

  private async onCopyAllClick(): Promise<void> {
    const payload = this.store.toPayload(
      this.editor,
      this.workspaceRelativePath,
      this.getLineMap(),
      this.getRawMarkdown(),
    );
    if (!payload) return; // empty store — silent no-op

    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      // No clipboard API available.
      console.warn('[LlmToggle] navigator.clipboard unavailable');
      this.flashCopyLabel('Copy failed', 3000);
      return;
    }

    try {
      await navigator.clipboard.writeText(payload);
      this.flashCopyLabel('Copied ✓', 1500);
    } catch (err) {
      console.warn('[LlmToggle] clipboard writeText failed', err);
      this.flashCopyLabel('Copy failed', 3000);
    }
  }

  private flashCopyLabel(label: string, ms: number): void {
    if (this.copyLabelTimeout) {
      clearTimeout(this.copyLabelTimeout);
      this.copyLabelTimeout = null;
    }
    this.copyAllBtn.textContent = label;
    this.copyLabelTimeout = setTimeout(() => {
      this.copyLabelTimeout = null;
      // Restore reactive label based on current store count.
      this.updateActionRow();
    }, ms);
  }

  private onClearAllClick(): void {
    this.store.clear();
    (this.editor.commands as unknown as { clearAllLlmComments: () => boolean }).clearAllLlmComments();
  }

  private showErrorBanner(message: string): void {
    this.errorBannerEl.textContent = message;
    this.errorBannerEl.style.display = 'block';
    if (this.errorBannerTimeout) clearTimeout(this.errorBannerTimeout);
    this.errorBannerTimeout = setTimeout(() => {
      this.errorBannerEl.style.display = 'none';
      this.errorBannerTimeout = null;
    }, 4000);
  }

  dispose(): void {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
    if (this.docUpdateListener) {
      this.editor.off('update', this.docUpdateListener);
      this.docUpdateListener = null;
    }
    if (this.copyLabelTimeout) {
      clearTimeout(this.copyLabelTimeout);
      this.copyLabelTimeout = null;
    }
    if (this.errorBannerTimeout) {
      clearTimeout(this.errorBannerTimeout);
      this.errorBannerTimeout = null;
    }
    this.toggleBtn.remove();
    this.barEl.remove();
    this.errorBannerEl.remove();
  }
}
