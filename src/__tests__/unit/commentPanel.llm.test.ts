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
  const tr = { setMeta: vi.fn().mockReturnThis() };
  return {
    commands: {
      unsetLlmCommentById: vi.fn(() => true),
    },
    view: {
      state: { tr },
      dispatch: vi.fn(),
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

  // L5: openLlmLine single-entry display with navigation
  it('L5: openLlmLine renders single entry at a time; navigation available for multiple', () => {
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

    // Only one entry rendered at a time
    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(1);

    // First entry shown is the line-kind (sorted: line first, then text by createdAt)
    const body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('line note');

    // Navigation is present
    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel).not.toBeNull();
    expect(navLabel!.textContent).toBe('1 of 3');
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

  // L9: Copy button is at panel bottom, not in action row
  it('L9: Copy button is at panel bottom, not in action row', () => {
    llmStore.add(makeLlmComment({
      id: 'c-1',
      kind: 'line',
      body: 'my note',
      startLine: 4,
      endLine: 4,
    }));

    panel.openLlmLine(4, anchor);

    // No copy in the action row
    const actionCopy = container.querySelector('.llm-entry-copy');
    expect(actionCopy).toBeNull();

    // Copy button at panel bottom
    const bottomCopy = container.querySelector('.llm-copy-single');
    expect(bottomCopy).not.toBeNull();
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

  // Navigation: shows "1 of 3" when 3 comments on same line
  it('Navigation shows "1 of N" when multiple comments on same line', () => {
    llmStore.add(makeLlmComment({ id: 'a', body: 'first', startLine: 7, endLine: 7, createdAt: 100 }));
    llmStore.add(makeLlmComment({ id: 'b', body: 'second', startLine: 7, endLine: 7, createdAt: 200 }));
    llmStore.add(makeLlmComment({ id: 'c', body: 'third', startLine: 7, endLine: 7, createdAt: 300 }));

    panel.openLlmLine(7, anchor);

    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel).not.toBeNull();
    expect(navLabel!.textContent).toBe('1 of 3');

    // Only one comment entry rendered
    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(1);
  });

  // Navigation: prev/next buttons cycle through comments
  it('Prev/next buttons cycle through comments', () => {
    llmStore.add(makeLlmComment({ id: 'a', body: 'first', startLine: 7, endLine: 7, createdAt: 100 }));
    llmStore.add(makeLlmComment({ id: 'b', body: 'second', startLine: 7, endLine: 7, createdAt: 200 }));

    panel.openLlmLine(7, anchor);

    // Initially shows first
    let body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('first');

    // Click next
    const nextBtn = container.querySelectorAll('.llm-nav-btn')[1] as HTMLButtonElement;
    nextBtn.click();

    body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('second');

    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel!.textContent).toBe('2 of 2');

    // Click prev
    const prevBtn = container.querySelectorAll('.llm-nav-btn')[0] as HTMLButtonElement;
    prevBtn.click();

    body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('first');
  });

  // No navigation when single comment
  it('No navigation UI when single comment on line', () => {
    llmStore.add(makeLlmComment({ id: 'a', body: 'solo', startLine: 5, endLine: 5 }));

    panel.openLlmLine(5, anchor);

    const nav = container.querySelector('.llm-nav');
    expect(nav).toBeNull();

    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(1);
  });

  // Delete clamps currentLlmIndex
  it('Deleting currently displayed comment clamps index', () => {
    llmStore.add(makeLlmComment({ id: 'a', body: 'first', startLine: 7, endLine: 7, createdAt: 100 }));
    llmStore.add(makeLlmComment({ id: 'b', body: 'second', startLine: 7, endLine: 7, createdAt: 200 }));
    llmStore.add(makeLlmComment({ id: 'c', body: 'third', startLine: 7, endLine: 7, createdAt: 300 }));

    panel.openLlmLine(7, anchor);

    // Navigate to last (index 2) — re-query buttons after each click as DOM re-renders
    ;(container.querySelectorAll('.llm-nav-btn')[1] as HTMLButtonElement).click(); // index 1
    ;(container.querySelectorAll('.llm-nav-btn')[1] as HTMLButtonElement).click(); // index 2

    let body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('third');

    // Delete the third comment
    llmStore.remove('c');

    // After re-render, index should clamp to 1 (last valid)
    body = container.querySelector('.llm-comment-entry .comment-body');
    expect(body!.textContent).toBe('second');

    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel!.textContent).toBe('2 of 2');
  });

  // T-P1: Second save creates a reply (parentId set)
  it('T-P1: Second Save in line mode creates a reply with parentId', () => {
    panel.openLlmLine(5, anchor);

    // First save — creates root
    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'root comment';
    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn.click();

    const allComments = llmStore.getAll();
    expect(allComments.length).toBe(1);
    const rootId = allComments[0].id;
    expect(allComments[0].parentId).toBeUndefined();

    // Second save — creates reply
    const textarea2 = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea2.value = 'reply to root';
    const btn2 = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn2.click();

    const all = llmStore.getAll();
    expect(all.length).toBe(2);
    const reply = all.find(c => c.id !== rootId)!;
    expect(reply.parentId).toBe(rootId);
    expect(reply.body).toBe('reply to root');
  });

  // T-P2: Replies shown inline, no extra navigation
  it('T-P2: Root + replies shown together without extra navigation entries', () => {
    // Add a root with 2 replies
    llmStore.add(makeLlmComment({ id: 'root-1', body: 'root body', startLine: 5, endLine: 5, createdAt: 100 }));
    llmStore.add({ ...makeLlmComment({ id: 'r1', body: 'reply one', startLine: 5, endLine: 5, createdAt: 200 }), parentId: 'root-1' });
    llmStore.add({ ...makeLlmComment({ id: 'r2', body: 'reply two', startLine: 5, endLine: 5, createdAt: 300 }), parentId: 'root-1' });

    panel.openLlmLine(5, anchor);

    // Only 1 root → no navigation
    const nav = container.querySelector('.llm-nav');
    expect(nav).toBeNull();

    // Thread container exists
    const thread = container.querySelector('.llm-thread');
    expect(thread).not.toBeNull();

    // 3 entries visible (root + 2 replies)
    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(3);

    // 2 replies have .llm-reply-entry class
    const replyEntries = container.querySelectorAll('.llm-reply-entry');
    expect(replyEntries.length).toBe(2);
  });

  // T-P3: Reply badge shows "Reply"
  it('T-P3: Reply entries show "Reply" badge instead of "Line"', () => {
    llmStore.add(makeLlmComment({ id: 'root-1', body: 'root', startLine: 5, endLine: 5, createdAt: 100 }));
    llmStore.add({ ...makeLlmComment({ id: 'r1', body: 'reply', startLine: 5, endLine: 5, createdAt: 200 }), parentId: 'root-1' });

    panel.openLlmLine(5, anchor);

    const badges = Array.from(container.querySelectorAll('.comment-pending-label')).map(el => el.textContent);
    expect(badges).toContain('Line');
    expect(badges).toContain('Reply');
  });

  // T-P4: Navigation between threads (not replies)
  it('T-P4: Navigation is between threads, not individual replies', () => {
    // Thread 1: root + 1 reply
    llmStore.add(makeLlmComment({ id: 'root-a', body: 'thread A root', startLine: 5, endLine: 5, createdAt: 100 }));
    llmStore.add({ ...makeLlmComment({ id: 'reply-a', body: 'thread A reply', startLine: 5, endLine: 5, createdAt: 150 }), parentId: 'root-a' });

    // Thread 2: root only
    llmStore.add(makeLlmComment({ id: 'root-b', body: 'thread B root', startLine: 5, endLine: 5, createdAt: 200 }));

    panel.openLlmLine(5, anchor);

    // Navigation shows "1 of 2" (2 threads, not 3 individual comments)
    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel).not.toBeNull();
    expect(navLabel!.textContent).toBe('1 of 2');

    // First view shows thread A (root + reply)
    let entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(2); // root + reply
    let bodies = Array.from(entries).map(e => e.querySelector('.comment-body')!.textContent);
    expect(bodies).toContain('thread A root');
    expect(bodies).toContain('thread A reply');

    // Navigate to thread B
    const nextBtn = container.querySelectorAll('.llm-nav-btn')[1] as HTMLButtonElement;
    nextBtn.click();

    entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(1); // just root-b
    const body = entries[0].querySelector('.comment-body')!.textContent;
    expect(body).toBe('thread B root');

    const navLabel2 = container.querySelector('.llm-nav-label');
    expect(navLabel2!.textContent).toBe('2 of 2');
  });

  // T-P5: Textarea placeholder updates to "Type a reply..."
  it('T-P5: Textarea placeholder changes to "Type a reply..." after first save', () => {
    panel.openLlmLine(5, anchor);

    // Initially "Type a comment..."
    let textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Type a comment...');

    // Save first comment
    textarea.value = 'first comment';
    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn.click();

    // After save and re-render, placeholder should update
    textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Type a reply...');
  });

  // T-P6: Cascade delete removes thread from UI
  it('T-P6: Deleting root removes entire thread from panel', () => {
    llmStore.add(makeLlmComment({ id: 'root-1', body: 'root', startLine: 5, endLine: 5, createdAt: 100 }));
    llmStore.add({ ...makeLlmComment({ id: 'r1', body: 'reply', startLine: 5, endLine: 5, createdAt: 200 }), parentId: 'root-1' });

    panel.openLlmLine(5, anchor);

    // Verify thread is shown
    expect(container.querySelectorAll('.llm-comment-entry').length).toBe(2);

    // Delete root — cascade removes reply too
    llmStore.remove('root-1');

    // Panel should show no entries
    expect(container.querySelectorAll('.llm-comment-entry').length).toBe(0);
  });

  // T-P7: openLlmNewText shows fresh empty box (no existing comments)
  it('T-P7: openLlmNewText shows fresh box, not existing comments', () => {
    // Pre-existing comment on line 5
    llmStore.add(makeLlmComment({ id: 'existing', body: 'existing note', startLine: 5, endLine: 5, createdAt: 100 }));

    panel.openLlmNewText('new-id', anchor, 5, 5);

    // No existing comment entries shown
    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBe(0);

    // No navigation
    const nav = container.querySelector('.llm-nav');
    expect(nav).toBeNull();

    // No copy section
    const copySection = container.querySelector('.llm-copy-section');
    expect(copySection).toBeNull();

    // Textarea is empty and focused
    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('');
  });

  // T-P8: After saving newText, panel transitions to line view with navigation
  it('T-P8: Saving newText transitions to line view showing new comment as navigable entry', () => {
    // Pre-existing comment on line 5
    llmStore.add(makeLlmComment({ id: 'existing', body: 'existing note', startLine: 5, endLine: 5, createdAt: 100 }));

    panel.openLlmNewText('new-text-id', anchor, 5, 5);

    // Save the new text comment
    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'new text comment';
    const btn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    btn.click();

    // Panel should still be open (not closed)
    expect(panel.isOpen()).toBe(true);

    // Should now show entries (transitioned to line view)
    const entries = container.querySelectorAll('.llm-comment-entry');
    expect(entries.length).toBeGreaterThan(0);

    // Navigation should show "X of 2" (existing + new)
    const navLabel = container.querySelector('.llm-nav-label');
    expect(navLabel).not.toBeNull();
    expect(navLabel!.textContent).toContain('of 2');
  });

  // T-P9: Copy button copies only the current thread
  it('T-P9: Copy button copies only the currently displayed thread', async () => {
    // Thread 1
    llmStore.add(makeLlmComment({ id: 'root-a', body: 'thread A note', startLine: 5, endLine: 5, createdAt: 100 }));
    llmStore.add({ ...makeLlmComment({ id: 'reply-a', body: 'thread A reply', startLine: 5, endLine: 5, createdAt: 150 }), parentId: 'root-a' });
    // Thread 2
    llmStore.add(makeLlmComment({ id: 'root-b', body: 'thread B note', startLine: 5, endLine: 5, createdAt: 200 }));

    panel.openLlmLine(5, anchor);

    // Click copy (currently showing thread A)
    const copyBtn = container.querySelector('.llm-copy-single') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();

    // Wait for async clipboard
    await new Promise(r => setTimeout(r, 10));

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    const copied = clipboardWriteText.mock.calls[0][0] as string;
    expect(copied).toContain('thread A note');
    expect(copied).toContain('thread A reply');
    expect(copied).not.toContain('thread B');
  });
});
