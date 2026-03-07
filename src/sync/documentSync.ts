import * as vscode from 'vscode';
import { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './syncProtocol';

export class DocumentSyncManager {
  private currentVersion: number = 0;
  private isApplyingEdit: boolean = false;
  private lastAppliedContent: string | null = null;
  private document: vscode.TextDocument;
  private webview: vscode.Webview;
  private readonly isReadOnly: boolean;
  private readonly documentDirUri: string;

  constructor(document: vscode.TextDocument, webview: vscode.Webview, isReadOnly: boolean = false, documentDirUri: string = '') {
    this.document = document;
    this.webview = webview;
    this.isReadOnly = isReadOnly;
    this.documentDirUri = documentDirUri;
  }

  async handleWebviewMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postMessage({ type: 'init', markdown: this.document.getText(), isReadOnly: this.isReadOnly, documentDirUri: this.documentDirUri });
        break;

      case 'edit':
        if (this.isReadOnly) return;
        if (msg.version >= this.currentVersion) {
          await this.applyMarkdownEdit(msg.markdown);
        }
        break;

      case 'undo':
        if (this.isReadOnly) return;
        vscode.commands.executeCommand('undo');
        break;

      case 'redo':
        if (this.isReadOnly) return;
        vscode.commands.executeCommand('redo');
        break;

      case 'save':
        if (this.isReadOnly) return;
        await this.applyMarkdownEdit(msg.markdown);
        await this.document.save();
        break;

      case 'openFile': {
        const docDir = vscode.Uri.joinPath(this.document.uri, '..');
        const fileUri = vscode.Uri.joinPath(docDir, msg.src);
        vscode.commands.executeCommand('vscode.open', fileUri);
        break;
      }
    }
  }

  handleDocumentChange(document: vscode.TextDocument): void {
    if (this.isApplyingEdit) {
      return;
    }
    if (document.uri.toString() !== this.document.uri.toString()) {
      return;
    }

    const content = document.getText();
    if (this.lastAppliedContent !== null &&
        content.trimEnd() === this.lastAppliedContent.trimEnd()) {
      // keep lastAppliedContent for subsequent echoes
      return;
    }

    this.currentVersion++;
    this.postMessage({
      type: 'externalUpdate',
      markdown: content,
      version: this.currentVersion,
      documentDirUri: this.documentDirUri,
    });
  }

  private async applyMarkdownEdit(markdown: string): Promise<void> {
    const fullRange = new vscode.Range(0, 0, this.document.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, markdown);

    this.lastAppliedContent = markdown;
    this.isApplyingEdit = true;
    await vscode.workspace.applyEdit(edit);
    this.currentVersion++;
    this.isApplyingEdit = false;
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.webview.postMessage(message);
  }
}
