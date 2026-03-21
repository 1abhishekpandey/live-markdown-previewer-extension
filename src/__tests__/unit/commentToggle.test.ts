// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tiptap/core', () => ({
  Editor: class {},
}));

import { CommentToggle } from '../../webview/commentToggle';
import type { PendingCommentStore } from '../../webview/pendingCommentStore';
import type { CommentDataMessage, ReviewSubmitResultMessage, CommentErrorMessage } from '../../sync/syncProtocol';

function makeVscode() {
  return { postMessage: vi.fn() };
}

function makeEditor() {
  const dom = document.createElement('div');
  const wrapper = document.createElement('div');
  wrapper.appendChild(dom);
  document.body.appendChild(wrapper);
  return {
    setEditable: vi.fn(),
    isEditable: true,
    view: { dom },
  } as unknown as import('@tiptap/core').Editor;
}

function makeStore(count = 0): PendingCommentStore {
  const listeners = new Set<() => void>();
  return {
    getCount: vi.fn(() => count),
    getAll: vi.fn(() => []),
    onChange: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    // Helper to simulate count change
    _setCount(n: number) {
      (this.getCount as ReturnType<typeof vi.fn>).mockReturnValue(n);
      for (const l of listeners) l();
    },
  } as unknown as PendingCommentStore & { _setCount(n: number): void };
}

function makeCommentDataMsg(overrides?: Partial<CommentDataMessage>): CommentDataMessage {
  return {
    type: 'commentData',
    threads: [],
    prNumber: 123,
    prUrl: 'https://github.com/owner/repo/pull/123',
    currentUser: 'testuser',
    diffHighlightLines: [],
    lastFetchedAt: Date.now(),
    ...overrides,
  };
}

describe('CommentToggle', () => {
  let toggle: CommentToggle;

  afterEach(() => {
    toggle?.dispose();
    // Clean up any appended elements
    document.body.innerHTML = '';
  });

  it('constructor creates 4 DOM elements (toggle, refresh, submit, staleness)', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    const toggleBtn = document.querySelector('.review-toggle');
    const refreshBtn = document.querySelector('.review-refresh');
    const submitBtn = document.querySelector('.review-submit');
    const stalenessEl = document.querySelector('.review-staleness');

    expect(toggleBtn).not.toBeNull();
    expect(refreshBtn).not.toBeNull();
    expect(submitBtn).not.toBeNull();
    expect(stalenessEl).not.toBeNull();
  });

  it('toggle click sends commentToggle { enabled: true }', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    const toggleBtn = document.querySelector('.review-toggle') as HTMLButtonElement;
    toggleBtn.click();

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'commentToggle', enabled: true });
  });

  it('handleCommentData updates button text to "Review: On"', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg({ prNumber: 123 }));

    const toggleBtn = document.querySelector('.review-toggle') as HTMLButtonElement;
    expect(toggleBtn.textContent).toBe('Review: On');
    const prBadge = document.querySelector('.review-pr-badge') as HTMLSpanElement;
    expect(prBadge.textContent).toBe('PR #123');
  });

  it('handleCommentData sets editor to read-only (setEditable false)', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg());

    expect(editor.setEditable).toHaveBeenCalledWith(false, false);
  });

  it('handleCommentData shows review bar', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    const reviewBar = document.querySelector('.review-bar') as HTMLDivElement;
    expect(reviewBar.style.display).toBe('none');

    toggle.handleCommentData(makeCommentDataMsg());

    expect(reviewBar.style.display).toBe('');
  });

  it('refresh click sends commentRefresh', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    // Activate review mode first
    toggle.handleCommentData(makeCommentDataMsg());

    const refreshBtn = document.querySelector('.review-refresh') as HTMLButtonElement;
    refreshBtn.click();

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'commentRefresh' });
  });

  it('submit button shows count from store (e.g. "Submit Review (2)")', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(2) as PendingCommentStore & { _setCount(n: number): void };
    toggle = new CommentToggle(editor, vscode, store);

    // Activate review mode so submit button can appear
    toggle.handleCommentData(makeCommentDataMsg());

    const submitBtn = document.querySelector('.review-submit') as HTMLButtonElement;
    expect(submitBtn.textContent).toBe('Submit Review (2)');
    expect(submitBtn.style.display).toBe('');
  });

  it('actions row hidden when count is 0', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(0);
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg());

    const actionsRow = document.querySelector('.review-actions-row') as HTMLDivElement;
    expect(actionsRow.style.display).toBe('none');
  });

  it('submit click sends submitReview immediately', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(2);
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg());

    const submitBtn = document.querySelector('.review-submit') as HTMLButtonElement;
    submitBtn.click();

    expect(submitBtn.textContent).toBe('Submitting...');
    expect(submitBtn.disabled).toBe(true);
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'submitReview' }));
  });

  it('handleSubmitResult success shows checkmark, reverts after timeout', () => {
    vi.useFakeTimers();
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(1);
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg());

    const msg: ReviewSubmitResultMessage = { type: 'reviewSubmitResult', success: true };
    toggle.handleSubmitResult(msg);

    const submitBtn = document.querySelector('.review-submit') as HTMLButtonElement;
    expect(submitBtn.textContent).toBe('✓ Submitted');

    vi.advanceTimersByTime(2000);
    // After timeout, reverts to count-based text (count is 1)
    expect(submitBtn.textContent).toBe('Submit Review (1)');
    vi.useRealTimers();
  });

  it('handleSubmitResult error shows error message', () => {
    vi.useFakeTimers();
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(1);
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg());

    const msg: ReviewSubmitResultMessage = { type: 'reviewSubmitResult', success: false, error: 'Rate limited' };
    toggle.handleSubmitResult(msg);

    // Error shown in the review-error element, not the submit button
    const errorEl = document.querySelector('.review-error') as HTMLSpanElement;
    expect(errorEl.textContent).toBe('Rate limited');
    expect(errorEl.style.display).toBe('');

    // Submit button reverts to idle
    const submitBtn = document.querySelector('.review-submit') as HTMLButtonElement;
    expect(submitBtn.textContent).toBe('Submit Review (1)');

    vi.advanceTimersByTime(8000);
    expect(errorEl.style.display).toBe('none');
    vi.useRealTimers();
  });

  it('handleError shows error text in review bar', () => {
    vi.useFakeTimers();
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    const msg: CommentErrorMessage = { type: 'commentError', message: 'No PR found' };
    toggle.handleError(msg);

    const errorEl = document.querySelector('.review-error') as HTMLSpanElement;
    expect(errorEl.textContent).toBe('No PR found');
    expect(errorEl.style.display).toBe('');

    vi.advanceTimersByTime(8000);
    expect(errorEl.style.display).toBe('none');
    vi.useRealTimers();
  });

  it('toggle OFF sends commentToggle { enabled: false }, sets editor editable, hides UI', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    // First activate
    toggle.handleCommentData(makeCommentDataMsg());
    vscode.postMessage.mockClear();

    // Now toggle OFF
    const toggleBtn = document.querySelector('.review-toggle') as HTMLButtonElement;
    toggleBtn.click();

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'commentToggle', enabled: false });
    expect(editor.setEditable).toHaveBeenCalledWith(true, false);
    expect(toggleBtn.textContent).toBe('Review: Off');

    const reviewBar = document.querySelector('.review-bar') as HTMLDivElement;
    expect(reviewBar.style.display).toBe('none');
  });

  it('staleness shows "just now" for recent fetch', () => {
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore();
    toggle = new CommentToggle(editor, vscode, store);

    toggle.handleCommentData(makeCommentDataMsg({ lastFetchedAt: Date.now() }));

    const stalenessEl = document.querySelector('.review-staleness') as HTMLSpanElement;
    expect(stalenessEl.textContent).toBe('just now');
  });

  it('dispose clears interval and unsubscribes', () => {
    vi.useFakeTimers();
    const vscode = makeVscode();
    const editor = makeEditor();
    const store = makeStore(2) as PendingCommentStore & { _setCount(n: number): void };
    toggle = new CommentToggle(editor, vscode, store);

    // Activate to start staleness timer
    toggle.handleCommentData(makeCommentDataMsg());

    toggle.dispose();

    // After dispose, store change should not update submit button
    const submitBtn = document.querySelector('.review-submit') as HTMLButtonElement;
    const textBefore = submitBtn.textContent;

    // Trigger store change — since unsubscribed, button should not update
    store._setCount(5);
    expect(submitBtn.textContent).toBe(textBefore);
    vi.useRealTimers();
  });
});
