import * as vscode from 'vscode';
import { DocumentSyncManager } from './sync/documentSync';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    // Configure webview
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    // Get URIs for webview assets
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );

    // Generate nonce for CSP
    const nonce = getNonce();

    // Set HTML content
    webview.html = getWebviewContent(webview, scriptUri, styleUri, nonce);

    // Detect read-only documents (e.g. git base versions from Source Control)
    const writableSchemes = new Set(['file', 'untitled']);
    const isReadOnly = !writableSchemes.has(document.uri.scheme);

    // Create sync manager
    const syncManager = new DocumentSyncManager(document, webview, isReadOnly);

    // Wire up message handling from webview
    const messageDisposable = webview.onDidReceiveMessage((msg) => {
      syncManager.handleWebviewMessage(msg).catch((err) => {
        console.error('[md-editor] Error handling webview message:', err);
      });
    });

    // Wire up document change handling (skip for read-only — git blobs don't change mid-session)
    const changeDisposable = isReadOnly
      ? undefined
      : vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === document.uri.toString()) {
            syncManager.handleDocumentChange(e.document);
          }
        });

    // Re-sync when panel becomes visible again
    const viewStateDisposable = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) {
        // Webview will send 'ready' when it reconnects, but also proactively send update
        webview.postMessage({
          type: 'externalUpdate',
          markdown: document.getText(),
          version: 0, // Force refresh
        });
      }
    });

    // Cleanup on dispose
    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      changeDisposable?.dispose();
      viewStateDisposable.dispose();
    });
  }

}

function getWebviewContent(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  nonce: string
): string {
  const cspSource = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Markdown Editor</title>
</head>
<body>
  <div id="loading-overlay"><div class="loading-spinner"></div></div>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
