vi.mock('vscode', () => ({
  Range: vi.fn().mockImplementation(function(sl: number, sc: number, el: number, ec: number) { return { sl, sc, el, ec }; }),
  WorkspaceEdit: vi.fn().mockImplementation(function() { return { replace: vi.fn() }; }),
  workspace: { applyEdit: vi.fn().mockResolvedValue(true) },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}));

import * as vscode from 'vscode';
import { DocumentSyncManager } from '../../sync/documentSync';

function makeWebview() {
  return { postMessage: vi.fn() };
}

function makeDocument(content = '# Hello', uri = 'file:///test.md') {
  return {
    getText: vi.fn().mockReturnValue(content),
    uri: { toString: () => uri },
    lineCount: content.split('\n').length,
    save: vi.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
  (vscode.workspace.applyEdit as any).mockResolvedValue(true);
  (vscode.commands.executeCommand as any).mockResolvedValue(undefined);
});

describe('handleWebviewMessage', () => {
  it('sends init message on ready', async () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'ready' });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'init', markdown: '# Hello', isReadOnly: false,
    });
  });

  it('sends isReadOnly: true in init when constructed with isReadOnly', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any, true);
    await mgr.handleWebviewMessage({ type: 'ready' });
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isReadOnly: true })
    );
  });

  it('applies edit when version >= currentVersion', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# New', version: 0 });
    expect(vscode.workspace.applyEdit).toHaveBeenCalledOnce();
  });

  it('drops stale edit when version < currentVersion', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    // First edit at version 0 → accepted, bumps currentVersion to 1
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# First', version: 0 });
    vi.clearAllMocks();
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);
    // Second edit with old version 0 → stale, currentVersion is now 1
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# Stale', version: 0 });
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('ignores edit when isReadOnly', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any, true);
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# X', version: 0 });
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('applies edit and saves document on save', async () => {
    const webview = makeWebview();
    const doc = makeDocument('# Original');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'save', markdown: '# Updated' });
    expect(vscode.workspace.applyEdit).toHaveBeenCalledOnce();
    expect(doc.save).toHaveBeenCalledOnce();
    // Verify the WorkspaceEdit.replace was called with the new markdown
    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    expect(editInstance.replace).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '# Updated'
    );
  });

  it('ignores save when isReadOnly', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any, true);
    await mgr.handleWebviewMessage({ type: 'save', markdown: '# X' });
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('executes undo command', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'undo' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('undo');
  });

  it('executes redo command', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'redo' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('redo');
  });

  it('ignores undo when isReadOnly', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any, true);
    await mgr.handleWebviewMessage({ type: 'undo' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('ignores redo when isReadOnly', async () => {
    const webview = makeWebview();
    const doc = makeDocument();
    const mgr = new DocumentSyncManager(doc as any, webview as any, true);
    await mgr.handleWebviewMessage({ type: 'redo' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe('handleDocumentChange', () => {
  it('sends externalUpdate on document change', () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    const changedDoc = makeDocument('# World');
    mgr.handleDocumentChange(changedDoc as any);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'externalUpdate',
      markdown: '# World',
      version: 1,
    });
  });

  it('does not send externalUpdate while applying edit (echo prevention)', async () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    // Make applyEdit a promise that we can control
    let resolveEdit!: () => void;
    const editPromise = new Promise<boolean>(resolve => {
      resolveEdit = () => resolve(true);
    });
    (vscode.workspace.applyEdit as any).mockReturnValueOnce(editPromise);

    // Start edit — isApplyingEdit becomes true synchronously before await
    const editDone = mgr.handleWebviewMessage({ type: 'edit', markdown: '# New', version: 0 });

    // Call handleDocumentChange while edit is in-flight
    const changedDoc = makeDocument('# New'); // same URI
    mgr.handleDocumentChange(changedDoc as any);

    // webview.postMessage should NOT have been called (isApplyingEdit is true)
    expect(webview.postMessage).not.toHaveBeenCalled();

    // Clean up: resolve the edit so the manager doesn't hang
    resolveEdit();
    await editDone;
  });

  it('ignores document change for different URI', () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello', 'file:///test.md');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    const otherDoc = makeDocument('# Other', 'file:///other.md');
    mgr.handleDocumentChange(otherDoc as any);
    expect(webview.postMessage).not.toHaveBeenCalled();
  });

  it('skips externalUpdate when content matches lastAppliedContent', async () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    // Apply an edit to set lastAppliedContent
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# Hello', version: 0 });
    vi.clearAllMocks();
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);
    // Now call handleDocumentChange with the same content
    const sameDoc = makeDocument('# Hello');
    mgr.handleDocumentChange(sameDoc as any);
    expect(webview.postMessage).not.toHaveBeenCalled();
  });

  it('increments version counter on each external change', () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    const changedDoc1 = makeDocument('# A');
    const changedDoc2 = makeDocument('# B');
    mgr.handleDocumentChange(changedDoc1 as any);
    mgr.handleDocumentChange(changedDoc2 as any);
    const calls = (webview.postMessage as any).mock.calls;
    expect(calls[0][0].version).toBe(1);
    expect(calls[1][0].version).toBe(2);
  });
});
