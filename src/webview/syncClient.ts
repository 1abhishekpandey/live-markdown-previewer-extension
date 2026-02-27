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
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  private static readonly DEBOUNCE_MS = 300;

  constructor(editor: Editor, vscode: VsCodeApi) {
    this.editor = editor;
    this.vscode = vscode;
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
        break;

      case 'externalUpdate':
        if (msg.version <= this.currentVersion) return;

        this.isExternalUpdate = true;

        const { from, to } = this.editor.state.selection;

        this.editor.commands.setContent(msg.markdown);

        this.editor.commands.setTextSelection({
          from: Math.min(from, this.editor.state.doc.content.size - 1),
          to: Math.min(to, this.editor.state.doc.content.size - 1),
        });

        this.currentVersion = msg.version;
        this.isExternalUpdate = false;
        break;
    }
  }

  private debouncedSendEdit(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.sendEdit();
    }, SyncClient.DEBOUNCE_MS);
  }

  private sendEdit(): void {
    const markdown = this.editor.storage.markdown.getMarkdown();
    this.currentVersion++;
    this.vscode.postMessage({ type: 'edit', markdown, version: this.currentVersion });
  }

  private setupKeyboardShortcuts(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
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
