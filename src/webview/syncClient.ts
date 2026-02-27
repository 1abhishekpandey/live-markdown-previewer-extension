import { Editor } from '@tiptap/core';
import { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../sync/syncProtocol';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export class SyncClient {
  private editor: Editor;
  private vscode: VsCodeApi;
  private isExternalUpdate: boolean = false;
  private currentVersion: number = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingExternalUpdate: ExtensionToWebviewMessage | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private debounceDelayInMs: number = 300;
  private onFirstInit: (() => void) | undefined;

  constructor(editor: Editor, vscode: VsCodeApi, onFirstInit?: () => void) {
    this.editor = editor;
    this.vscode = vscode;
    this.onFirstInit = onFirstInit;
  }

  init(): void {
    this.editor.on('update', () => {
      if (this.isExternalUpdate) return;
      this.debouncedSendEdit();
    });

    this.setupKeyboardShortcuts();

    this.vscode.postMessage({ type: 'ready' });
  }

  handleMessage(msg: ExtensionToWebviewMessage): void {
    switch (msg.type) {
      case 'init':
        this.editor.commands.setContent(msg.markdown);
        this.setAdaptiveDebounce(msg.markdown.length);
        if (this.onFirstInit) {
          this.onFirstInit();
          this.onFirstInit = undefined;
        }
        break;

      case 'externalUpdate': {
        if (msg.version <= this.currentVersion) return;

        if (this.debounceTimer !== null) {
          this.pendingExternalUpdate = msg;
          break;
        }

        this.applyExternalUpdate(msg);
        break;
      }
    }
  }

  private setAdaptiveDebounce(charCount: number): void {
    if (charCount > 100_000) {
      this.debounceDelayInMs = 800;
    } else if (charCount > 30_000) {
      this.debounceDelayInMs = 500;
    } else {
      this.debounceDelayInMs = 300;
    }
  }

  private debouncedSendEdit(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.sendEdit();
    }, this.debounceDelayInMs);
  }

  private applyExternalUpdate(msg: ExtensionToWebviewMessage): void {
    if (msg.type !== 'externalUpdate') return;

    const currentMarkdown = this.editor.storage.markdown.getMarkdown();
    if (msg.markdown.trimEnd() === currentMarkdown.trimEnd()) {
      this.currentVersion = msg.version;
      return;
    }

    this.isExternalUpdate = true;

    const { from, to } = this.editor.state.selection;

    this.editor.commands.setContent(msg.markdown);

    this.editor.commands.setTextSelection({
      from: Math.min(from, this.editor.state.doc.content.size - 1),
      to: Math.min(to, this.editor.state.doc.content.size - 1),
    });

    this.currentVersion = msg.version;
    this.isExternalUpdate = false;
  }

  private sendEdit(): void {
    const markdown = this.editor.storage.markdown.getMarkdown();
    this.currentVersion++;
    this.vscode.postMessage({ type: 'edit', markdown, version: this.currentVersion });

    if (this.pendingExternalUpdate) {
      const pending = this.pendingExternalUpdate;
      this.pendingExternalUpdate = null;
      this.applyExternalUpdate(pending);
    }
  }

  private setupKeyboardShortcuts(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.id === 'search-input') return;

      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.vscode.postMessage({ type: 'undo' });
      } else if (e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        this.vscode.postMessage({ type: 'redo' });
      } else if (e.key === 's') {
        e.preventDefault();
        const markdown = this.editor.storage.markdown.getMarkdown();
        this.vscode.postMessage({ type: 'save', markdown });
      }
    };

    document.addEventListener('keydown', this.keydownHandler);
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.keydownHandler !== null) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }
}
