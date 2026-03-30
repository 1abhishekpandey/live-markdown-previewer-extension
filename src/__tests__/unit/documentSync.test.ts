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
      type: 'init', markdown: '# Hello', isReadOnly: false, documentDirUri: '',
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
      documentDirUri: '',
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

describe('baseline and three-way merge', () => {
  it('stores baseline content on baseline message', async () => {
    const webview = makeWebview();
    const doc = makeDocument('# Hello');
    const mgr = new DocumentSyncManager(doc as any, webview as any);
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: '# Hello' });
    // Baseline is stored internally — verified indirectly by subsequent merge tests
  });

  it('preserves original content not in serialisation via three-way merge', async () => {
    const original = [
      '<p align="center">Logo</p>',
      '',
      '# Title',
      '',
      'Some text',
      '',
      '<!-- comment -->',
      '[ref]: https://example.com',
    ].join('\n');

    const baseline = [
      'Logo',
      '',
      '# Title',
      '',
      'Some text',
    ].join('\n');

    const edited = [
      'Logo',
      '',
      '# Title',
      '',
      'Some text with edit',
    ].join('\n');

    const doc = makeDocument(original);
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    // Simulate init flow
    await mgr.handleWebviewMessage({ type: 'ready' });
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: baseline });

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    // Send edit
    await mgr.handleWebviewMessage({ type: 'edit', markdown: edited, version: 0 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    // HTML block at top preserved
    expect(appliedContent).toContain('<p align="center">Logo</p>');
    // User's edit applied
    expect(appliedContent).toContain('Some text with edit');
    // Comment and reference link preserved
    expect(appliedContent).toContain('<!-- comment -->');
    expect(appliedContent).toContain('[ref]: https://example.com');
  });

  it('handles pure insertion in opaque region', async () => {
    const original = [
      '<p align="center">Header</p>',
      '',
      '# Title',
      '',
      'Content',
    ].join('\n');

    const baseline = [
      'Header',
      '',
      '# Title',
      '',
      'Content',
    ].join('\n');

    // User inserted "new line" before the header text
    const edited = [
      'Header',
      '',
      'new line',
      '',
      '# Title',
      '',
      'Content',
    ].join('\n');

    const doc = makeDocument(original);
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    await mgr.handleWebviewMessage({ type: 'ready' });
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: baseline });

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    await mgr.handleWebviewMessage({ type: 'edit', markdown: edited, version: 0 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    // Original HTML preserved
    expect(appliedContent).toContain('<p align="center">Header</p>');
    // Insertion applied
    expect(appliedContent).toContain('new line');
    // Heading still present
    expect(appliedContent).toContain('# Title');
  });

  it('handles replacement in transparent region', async () => {
    const original = [
      '# Title',
      '',
      'Old heading text',
      '',
      'Paragraph',
    ].join('\n');

    const baseline = [
      '# Title',
      '',
      'Old heading text',
      '',
      'Paragraph',
    ].join('\n');

    const edited = [
      '# Title',
      '',
      'New heading text',
      '',
      'Paragraph',
    ].join('\n');

    const doc = makeDocument(original);
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    await mgr.handleWebviewMessage({ type: 'ready' });
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: baseline });

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    await mgr.handleWebviewMessage({ type: 'edit', markdown: edited, version: 0 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    expect(appliedContent).not.toContain('Old heading text');
    expect(appliedContent).toContain('New heading text');
    expect(appliedContent).toContain('# Title');
    expect(appliedContent).toContain('Paragraph');
  });

  it('falls back to full replacement without baseline', async () => {
    const doc = makeDocument('# Hello');
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    // Send ready but NO baseline
    await mgr.handleWebviewMessage({ type: 'ready' });

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# Replaced', version: 0 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    // Without baseline, falls back to full replacement
    expect(appliedContent).toBe('# Replaced');
  });

  it('external change invalidates baseline', async () => {
    const original = '# Hello\n\n<!-- keep -->';
    const baseline = '# Hello';

    const doc = makeDocument(original);
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    await mgr.handleWebviewMessage({ type: 'ready' });
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: baseline });

    // External change invalidates baseline
    const changedDoc = makeDocument('# Changed externally');
    mgr.handleDocumentChange(changedDoc as any);

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    // Next edit falls back to full replacement (baseline was invalidated)
    await mgr.handleWebviewMessage({ type: 'edit', markdown: '# After external', version: 2 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    // Full replacement since baseline was nulled
    expect(appliedContent).toBe('# After external');
  });

  it('returns original unchanged when baseline equals edited', async () => {
    const original = '# Hello\n\n<!-- preserved -->';
    const baseline = '# Hello';

    const doc = makeDocument(original);
    const webview = makeWebview();
    const mgr = new DocumentSyncManager(doc as any, webview as any);

    await mgr.handleWebviewMessage({ type: 'ready' });
    await mgr.handleWebviewMessage({ type: 'baseline', markdown: baseline });

    vi.clearAllMocks();
    (vscode.WorkspaceEdit as any).mockImplementation(function() { return { replace: vi.fn() }; });
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);

    // Send edit identical to baseline (no user change)
    await mgr.handleWebviewMessage({ type: 'edit', markdown: baseline, version: 0 });

    const editInstance = (vscode.WorkspaceEdit as any).mock.results[0].value;
    const appliedContent = editInstance.replace.mock.calls[0][2];

    // Should apply original unchanged
    expect(appliedContent).toBe(original);
  });
});
