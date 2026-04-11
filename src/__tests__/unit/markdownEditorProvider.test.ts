vi.mock('vscode', () => {
  const Uri = {
    joinPath: vi.fn((...parts: any[]) => ({
      toString: () => parts.map((p) => p?.toString?.() ?? String(p)).join('/'),
    })),
  };
  return {
    Uri,
    workspace: {
      asRelativePath: vi.fn((_uri: any, _includeWorkspaceFolder: boolean) => 'docs/test.md'),
      getWorkspaceFolder: vi.fn(() => ({
        uri: { fsPath: '/ws', toString: () => 'file:///ws' },
      })),
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: { executeCommand: vi.fn() },
    Range: vi.fn(),
    WorkspaceEdit: vi.fn().mockImplementation(() => ({ replace: vi.fn() })),
  };
});

// Stub the DocumentSyncManager constructor so we can inspect its args
vi.mock('../../sync/documentSync', () => ({
  DocumentSyncManager: vi.fn().mockImplementation(function (this: any, ..._args: any[]) {
    this.handleWebviewMessage = vi.fn().mockResolvedValue(undefined);
    this.handleDocumentChange = vi.fn();
  }),
}));

// Stub CommentHandler so the provider can instantiate it without real deps
vi.mock('../../gh/commentHandler', () => ({
  CommentHandler: vi.fn().mockImplementation(function (this: any) {
    this.handleCommentToggle = vi.fn().mockResolvedValue(undefined);
    this.handleCommentRefresh = vi.fn().mockResolvedValue(undefined);
    this.handleCommentOpenPr = vi.fn();
    this.handleValidateLine = vi.fn();
    this.handleSubmitReview = vi.fn().mockResolvedValue(undefined);
    this.handleSavePendingQueue = vi.fn();
  }),
}));

import * as vscode from 'vscode';
import { DocumentSyncManager } from '../../sync/documentSync';
import { MarkdownEditorProvider } from '../../markdownEditorProvider';

function makeContext() {
  return {
    extensionUri: { toString: () => 'file:///ext' },
    subscriptions: [],
  } as any;
}

function makeDocument(uriStr = 'file:///ws/docs/test.md') {
  return {
    uri: { toString: () => uriStr },
    getText: () => '# Test',
    lineCount: 1,
  } as any;
}

function makeWebviewPanel() {
  const webview = {
    asWebviewUri: vi.fn((u: any) => u),
    cspSource: 'vscode-resource:',
    html: '',
    options: {},
    onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    postMessage: vi.fn(),
  };
  return {
    webview,
    visible: true,
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace.asRelativePath as any).mockReturnValue('docs/test.md');
});

describe('MarkdownEditorProvider', () => {
  it('I1: passes workspaceRelativePath from asRelativePath(uri, false) to DocumentSyncManager', async () => {
    const provider = new MarkdownEditorProvider(makeContext());
    const doc = makeDocument();
    const panel = makeWebviewPanel();

    await provider.resolveCustomTextEditor(doc, panel, {} as any);

    // Verify asRelativePath was called with the doc URI AND explicit false (not default true)
    expect(vscode.workspace.asRelativePath).toHaveBeenCalledWith(doc.uri, false);

    // Verify DocumentSyncManager received the path as the 5th constructor arg
    expect(DocumentSyncManager).toHaveBeenCalledWith(
      doc,
      panel.webview,
      false,
      expect.any(String),
      'docs/test.md'
    );
  });

  it('I1: different asRelativePath return flows through unchanged', async () => {
    (vscode.workspace.asRelativePath as any).mockReturnValue('nested/path/to/file.md');
    const provider = new MarkdownEditorProvider(makeContext());
    const doc = makeDocument('file:///ws/nested/path/to/file.md');
    const panel = makeWebviewPanel();

    await provider.resolveCustomTextEditor(doc, panel, {} as any);

    expect(DocumentSyncManager).toHaveBeenCalledWith(
      doc,
      panel.webview,
      false,
      expect.any(String),
      'nested/path/to/file.md'
    );
  });

  it('getWebviewForUri returns the registered webview for a known doc URI', async () => {
    const provider = new MarkdownEditorProvider(makeContext());
    const doc = makeDocument('file:///ws/a.md');
    const panel = makeWebviewPanel();

    await provider.resolveCustomTextEditor(doc, panel, {} as any);

    expect(provider.getWebviewForUri('file:///ws/a.md')).toBe(panel.webview);
  });

  it('getWebviewForUri returns null for an unknown doc URI', () => {
    const provider = new MarkdownEditorProvider(makeContext());
    expect(provider.getWebviewForUri('file:///unknown.md')).toBeNull();
  });
});
