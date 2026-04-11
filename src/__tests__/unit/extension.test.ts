import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => {
  class FakeTabInputCustom {
    constructor(public uri: any, public viewType: string) {}
  }
  class FakeTabInputText {}
  class FakeTabInputTextDiff {}
  return {
    TabInputCustom: FakeTabInputCustom,
    TabInputText: FakeTabInputText,
    TabInputTextDiff: FakeTabInputTextDiff,
    Uri: {
      joinPath: vi.fn((base: any, ...parts: any[]) => ({ ...base, path: parts.join('/') })),
      parse: vi.fn(),
    },
    Range: vi.fn(),
    TextEditorRevealType: { AtTop: 'AtTop' },
    window: {
      registerCustomEditorProvider: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeTextEditorVisibleRanges: vi.fn(() => ({ dispose: vi.fn() })),
      tabGroups: {
        activeTabGroup: { activeTab: null as any },
        onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
      },
      activeTextEditor: null,
    },
    workspace: {
      asRelativePath: vi.fn(() => 'x.md'),
      getWorkspaceFolder: vi.fn(),
      applyEdit: vi.fn(),
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
      registerCommand: vi.fn((name: string, handler: (...args: any[]) => any) => ({
        __name: name,
        __handler: handler,
        dispose: vi.fn(),
      })),
      executeCommand: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock('../../markdownEditorProvider', () => ({
  MarkdownEditorProvider: vi.fn().mockImplementation(function (this: any) {
    this.getWebviewForUri = vi.fn();
    this.getLastWebviewScrollAnchor = vi.fn();
    this.setPendingPreviewAnchor = vi.fn();
    this.getActiveDocUri = vi.fn();
    this.storePendingRawAnchor = vi.fn();
    this.consumePendingRawAnchor = vi.fn();
  }),
}));

import * as vscode from 'vscode';
import { activate } from '../../extension';
import { MarkdownEditorProvider } from '../../markdownEditorProvider';

function makeContext() {
  return { subscriptions: [] as any[], extensionUri: {} as any } as any;
}

describe('activate — LLM-Assist command registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.window.tabGroups.activeTabGroup as any).activeTab = null;
  });

  it('I5: registers liveMarkdown.toggleLlmAssist and pushes the disposable to context.subscriptions', () => {
    const ctx = makeContext();
    activate(ctx);

    const calls = (vscode.commands.registerCommand as any).mock.calls;
    const names = calls.map((c: any) => c[0]);
    expect(names).toContain('liveMarkdown.toggleLlmAssist');

    const llmResult = (vscode.commands.registerCommand as any).mock.results.find(
      (r: any) => r.value.__name === 'liveMarkdown.toggleLlmAssist',
    );
    expect(llmResult).toBeDefined();
    expect(ctx.subscriptions).toContain(llmResult!.value);
  });

  it('I6: command handler calls getWebviewForUri and posts toggleLlmAssist to the webview', () => {
    const ctx = makeContext();
    activate(ctx);

    const registered = (vscode.commands.registerCommand as any).mock.results.find(
      (r: any) => r.value.__name === 'liveMarkdown.toggleLlmAssist',
    );
    expect(registered).toBeDefined();
    const handler = registered!.value.__handler;

    const providerInstance = (MarkdownEditorProvider as any).mock.results[0].value;
    const postMessage = vi.fn();
    providerInstance.getWebviewForUri.mockReturnValue({ postMessage });

    (vscode.window.tabGroups.activeTabGroup as any).activeTab = {
      input: new (vscode as any).TabInputCustom(
        { toString: () => 'file:///ws/x.md' },
        'liveMarkdown.markdownEditor',
      ),
    };

    handler();

    expect(providerInstance.getWebviewForUri).toHaveBeenCalledWith('file:///ws/x.md');
    expect(postMessage).toHaveBeenCalledWith({ type: 'toggleLlmAssist' });
  });

  it('I6b: handler is a silent no-op when there is no active tab', () => {
    const ctx = makeContext();
    activate(ctx);

    const registered = (vscode.commands.registerCommand as any).mock.results.find(
      (r: any) => r.value.__name === 'liveMarkdown.toggleLlmAssist',
    );
    const handler = registered!.value.__handler;

    (vscode.window.tabGroups.activeTabGroup as any).activeTab = null;

    expect(() => handler()).not.toThrow();
  });

  it('I6c: handler silently ignores tabs whose viewType is not liveMarkdown', () => {
    const ctx = makeContext();
    activate(ctx);

    const registered = (vscode.commands.registerCommand as any).mock.results.find(
      (r: any) => r.value.__name === 'liveMarkdown.toggleLlmAssist',
    );
    const handler = registered!.value.__handler;

    const providerInstance = (MarkdownEditorProvider as any).mock.results[0].value;
    providerInstance.getWebviewForUri.mockReturnValue({ postMessage: vi.fn() });

    (vscode.window.tabGroups.activeTabGroup as any).activeTab = {
      input: new (vscode as any).TabInputCustom(
        { toString: () => 'file:///ws/x.md' },
        'some.other.editor',
      ),
    };

    handler();
    expect(providerInstance.getWebviewForUri).not.toHaveBeenCalled();
  });

  it('I6d: handler is a silent no-op when getWebviewForUri returns null', () => {
    const ctx = makeContext();
    activate(ctx);

    const registered = (vscode.commands.registerCommand as any).mock.results.find(
      (r: any) => r.value.__name === 'liveMarkdown.toggleLlmAssist',
    );
    const handler = registered!.value.__handler;

    const providerInstance = (MarkdownEditorProvider as any).mock.results[0].value;
    providerInstance.getWebviewForUri.mockReturnValue(null);

    (vscode.window.tabGroups.activeTabGroup as any).activeTab = {
      input: new (vscode as any).TabInputCustom(
        { toString: () => 'file:///ws/x.md' },
        'liveMarkdown.markdownEditor',
      ),
    };

    expect(() => handler()).not.toThrow();
  });
});
