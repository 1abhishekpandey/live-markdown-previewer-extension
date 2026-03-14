import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { DocumentSyncManager } from './sync/documentSync';
import { findAnchorLine } from './extension';

interface PanelAnchorState {
  lastAnchor: { anchorText: string; roughFraction: number } | null;
  webview: vscode.Webview;
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly context: vscode.ExtensionContext;
  private anchorStates = new Map<string, PanelAnchorState>();
  private pendingPreviewAnchors = new Map<string, { anchorText: string; lineIndex: number; totalLines: number }>();
  private activeDocUri: string | null = null;
  private pendingRawAnchor: { anchorText: string; roughFraction: number } | null = null;

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
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const resourceRoot = workspaceFolder?.uri ?? vscode.Uri.joinPath(document.uri, '..');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        resourceRoot,
      ],
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

    // Register scroll state for this document
    const docKey = document.uri.toString();
    this.anchorStates.set(docKey, { lastAnchor: null, webview: webviewPanel.webview });
    this.activeDocUri = docKey;

    // Create sync manager
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const documentDirUri = webview.asWebviewUri(documentDir).toString();
    const syncManager = new DocumentSyncManager(document, webview, false, documentDirUri);

    // Wire up message handling from webview
    const messageDisposable = webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'scrollAnchorUpdate') {
        const state = this.anchorStates.get(docKey);
        if (state) state.lastAnchor = { anchorText: msg.anchorText, roughFraction: msg.roughFraction };
        const line = findAnchorLine(document, msg.anchorText, msg.roughFraction);
        const lineText = document.lineAt(line).text;
        webview.postMessage({ type: 'debugLineInfo', lineNum: line + 1, lineText });
        return;
      }
      syncManager.handleWebviewMessage(msg).then(() => {
        if (msg.type === 'ready') {
          const pendingAnchor = this.pendingPreviewAnchors.get(docKey);
          if (pendingAnchor) {
            this.pendingPreviewAnchors.delete(docKey);
            webview.postMessage({ type: 'scrollToAnchor', ...pendingAnchor });
          }
        }
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[LiveMarkdown] Error handling webview message:', message);
      });
    });

    // Wire up document change handling
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        syncManager.handleDocumentChange(e.document);
      }
    });

    // Re-sync when panel becomes visible again
    const viewStateDisposable = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) {
        webview.postMessage({
          type: 'externalUpdate',
          markdown: document.getText(),
          version: 0,
        });
        this.activeDocUri = document.uri.toString();
      }
    });

    // Cleanup on dispose
    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      changeDisposable.dispose();
      viewStateDisposable.dispose();
      this.anchorStates.delete(docKey);
      if (this.activeDocUri === docKey) this.activeDocUri = null;
    });
  }

  getLastWebviewScrollAnchor(docUri: string): { anchorText: string; roughFraction: number } | null {
    return this.anchorStates.get(docUri)?.lastAnchor ?? null;
  }

  setPendingPreviewAnchor(docUri: string, anchor: { anchorText: string; lineIndex: number; totalLines: number }): void {
    this.pendingPreviewAnchors.set(docUri, anchor);
  }

  getActiveDocUri(): string | null {
    return this.activeDocUri;
  }

  storePendingRawAnchor(anchor: { anchorText: string; roughFraction: number }): void {
    this.pendingRawAnchor = anchor;
  }

  consumePendingRawAnchor(): { anchorText: string; roughFraction: number } | null {
    const a = this.pendingRawAnchor;
    this.pendingRawAnchor = null;
    return a;
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>LiveMarkdown</title>
</head>
<body>
  <div id="loading-overlay"><div class="loading-spinner"></div></div>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

