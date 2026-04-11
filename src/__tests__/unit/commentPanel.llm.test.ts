// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommentPanel } from '../../webview/commentPanel';
import { LlmCommentStore, type LlmComment } from '../../webview/llmCommentStore';

function makeVsCodeApi() {
  return { postMessage: vi.fn() };
}

function makeAnchorEl(): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  document.body.appendChild(el);
  return el;
}

function makeFakeEditor() {
  return {
    commands: {
      unsetLlmCommentById: vi.fn(() => true),
    },
  } as unknown as import('@tiptap/core').Editor;
}

function makePendingStoreStub() {
  return {
    getAll: vi.fn(() => []),
    add: vi.fn(),
    remove: vi.fn(),
    onChange: vi.fn(() => () => {}),
    getCount: vi.fn(() => 0),
  } as unknown as import('../../webview/pendingCommentStore').PendingCommentStore;
}

function makeLlmComment(overrides: Partial<LlmComment> = {}): LlmComment {
  return {
    id: 'c-1',
    kind: 'line',
    body: 'a note',
    createdAt: 100,
    startLine: 1,
    endLine: 1,
    ...overrides,
  };
}

describe('CommentPanel (LLM-Assist mode)', () => {
  let container: HTMLElement;
  let vscode: ReturnType<typeof makeVsCodeApi>;
  let pendingStore: ReturnType<typeof makePendingStoreStub>;
  let llmStore: LlmCommentStore;
  let editor: ReturnType<typeof makeFakeEditor>;
  let panel: CommentPanel;
  let anchor: HTMLElement;

  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    // happy-dom exposes navigator.clipboard as a getter; redefine the property.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    vscode = makeVsCodeApi();
    pendingStore = makePendingStoreStub();
    llmStore = new LlmCommentStore();
    editor = makeFakeEditor();
    panel = new CommentPanel(container, pendingStore, vscode, llmStore, editor);
    anchor = makeAnchorEl();
  });

  afterEach(() => {
    panel.dispose();
    container.remove();
    anchor.remove();
  });

  // L2: openLlmLine renders no thread-style entries
  it('L2: openLlmLine renders no thread-comment entries', () => {
    panel.openLlmLine(5, anchor);

    const outdated = container.querySelectorAll('.comment-entry-outdated');
    const drafts = container.querySelectorAll('.comment-entry-draft');
    const threadPending = container.querySelectorAll('.comment-entry-pending');
    expect(outdated.length).toBe(0);
    expect(drafts.length).toBe(0);
    expect(threadPending.length).toBe(0);
  });

  // L3: reply button text in LLM mode is 'Save'
  it('L3: reply button text in LLM mode is "Save"', () => {
    panel.openLlmLine(5, anchor);

    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Save');
  });

  // L4: empty Save is a no-op
  it('L4: empty textarea Save is a no-op', () => {
    const addSpy = vi.spyOn(llmStore, 'add');
    panel.openLlmLine(5, anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = '';
    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn.click();

    expect(addSpy).not.toHaveBeenCalled();

    // whitespace-only is also a no-op
    textarea.value = '   \n  ';
    btn.click();
    expect(addSpy).not.toHaveBeenCalled();
  });

  // L5: openLlmLine list order
  it('L5: openLlmLine renders entries in store order (line first, then text by createdAt)', () => {
    llmStore.add({
      id: 'line-A',
      kind: 'line',
      body: 'line note',
      createdAt: 500,
      startLine: 7,
      endLine: 7,
    });
    llmStore.add({
      id: 'text-A',
      kind: 'text',
      body: 'text note one',
      createdAt: 100,
      startLine: 7,
      endLine: 7,
    });
    llmStore.add({
      id: 'text-B',
      kind: 'text',
      body: 'text note two',
      createdAt: 200,
      startLine: 7,
      endLine: 7,
    });

    panel.openLlmLine(7, anchor);

    const bodies = Array.from(
      container.querySelectorAll('.llm-comment-entry .comment-body'),
    ).map((el) => el.textContent);
    expect(bodies).toEqual(['line note', 'text note one', 'text note two']);
  });

  // L6: openLlmText pre-fills textarea with existing body
  it('L6: openLlmText pre-fills textarea with the entry body', () => {
    llmStore.add(makeLlmComment({
      id: 'e-1',
      kind: 'text',
      body: 'existing note',
      startLine: 3,
      endLine: 3,
    }));

    panel.openLlmText('e-1', anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('existing note');
  });

  // L7: openLlmNewText opens with an empty textarea
  it('L7: openLlmNewText opens with an empty textarea', () => {
    panel.openLlmNewText('Y', anchor, 3, 5);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('');
  });

  // L8: Cancel on openLlmNewText unwinds mark; Save then close does NOT re-unwind
  it('L8: closing a new-text panel without Save calls unsetLlmCommentById', () => {
    panel.openLlmNewText('Y', anchor, 3, 5);
    panel.close();

    const unset = (editor.commands.unsetLlmCommentById as unknown as ReturnType<typeof vi.fn>);
    expect(unset).toHaveBeenCalledTimes(1);
    expect(unset).toHaveBeenCalledWith('Y');
  });

  it('L8: Save on a new-text panel clears pending creation so close does not unwind', () => {
    panel.openLlmNewText('Z', anchor, 3, 5);
    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'body text';
    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn.click();
    // Save closes the panel; close() runs once inside onLlmSaveClick, with pendingLlmCreation cleared first.
    // Calling close() again here is a no-op.
    panel.close();

    const unset = (editor.commands.unsetLlmCommentById as unknown as ReturnType<typeof vi.fn>);
    expect(unset).not.toHaveBeenCalled();
    expect(llmStore.get('Z')).toBeDefined();
    expect(llmStore.get('Z')!.body).toBe('body text');
  });

  // L9: Copy button writes body only
  it('L9: Copy button writes only the body, never a File: payload', () => {
    llmStore.add(makeLlmComment({
      id: 'c-1',
      kind: 'line',
      body: 'my note',
      startLine: 4,
      endLine: 4,
    }));

    panel.openLlmLine(4, anchor);

    const copyBtn = container.querySelector('.llm-entry-copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    const arg = clipboardWriteText.mock.calls[0][0] as string;
    expect(arg).toBe('my note');
    expect(arg).not.toContain('File:');
  });

  // L10: Delete on text entry calls both store.remove and unsetLlmCommentById
  it('L10: Delete on a text entry calls store.remove AND unsetLlmCommentById', () => {
    llmStore.add(makeLlmComment({
      id: 'text-del',
      kind: 'text',
      body: 'text to delete',
      startLine: 9,
      endLine: 9,
    }));
    const removeSpy = vi.spyOn(llmStore, 'remove');

    panel.openLlmLine(9, anchor);

    const deleteBtn = container.querySelector('.llm-entry-delete') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    deleteBtn.click();

    expect(removeSpy).toHaveBeenCalledWith('text-del');
    const unset = editor.commands.unsetLlmCommentById as unknown as ReturnType<typeof vi.fn>;
    expect(unset).toHaveBeenCalledTimes(1);
    expect(unset).toHaveBeenCalledWith('text-del');
  });

  // L11: Delete on line entry calls store.remove ONLY
  it('L11: Delete on a line entry calls store.remove only (not unsetLlmCommentById)', () => {
    llmStore.add(makeLlmComment({
      id: 'line-del',
      kind: 'line',
      body: 'line to delete',
      startLine: 9,
      endLine: 9,
    }));
    const removeSpy = vi.spyOn(llmStore, 'remove');

    panel.openLlmLine(9, anchor);

    const deleteBtn = container.querySelector('.llm-entry-delete') as HTMLButtonElement;
    deleteBtn.click();

    expect(removeSpy).toHaveBeenCalledWith('line-del');
    const unset = editor.commands.unsetLlmCommentById as unknown as ReturnType<typeof vi.fn>;
    expect(unset).not.toHaveBeenCalled();
  });

  // Extra: llmStore.onChange re-renders the list
  it('llmStore.onChange re-renders the list without closing the panel', () => {
    panel.openLlmLine(5, anchor);

    // Initially empty
    expect(container.querySelectorAll('.llm-comment-entry').length).toBe(0);

    llmStore.add({
      id: 'X',
      kind: 'line',
      body: 'added after open',
      createdAt: Date.now(),
      startLine: 5,
      endLine: 5,
    });

    // Panel still open
    expect(panel.isOpen()).toBe(true);

    const bodies = Array.from(
      container.querySelectorAll('.llm-comment-entry .comment-body'),
    ).map((el) => el.textContent);
    expect(bodies).toContain('added after open');
  });
});
