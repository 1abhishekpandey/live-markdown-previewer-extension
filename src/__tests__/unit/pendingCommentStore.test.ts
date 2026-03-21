import { describe, it, expect, vi } from 'vitest';
import { PendingCommentStore } from '../../webview/pendingCommentStore';
import type { PendingComment } from '../../sync/commentTypes';

function makeComment(overrides?: Partial<PendingComment>): PendingComment {
  return {
    tempId: crypto.randomUUID(),
    threadId: null,
    body: 'test comment',
    workingCopyLine: 10,
    workingCopyStartLine: null,
    diffLine: 5,
    diffStartLine: null,
    ...overrides,
  };
}

function makeVscode() {
  return { postMessage: vi.fn() };
}

describe('PendingCommentStore', () => {
  it('add: adds comment, getCount = 1, listener called, savePendingQueue sent', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);
    const listener = vi.fn();
    store.onChange(listener);

    const comment = makeComment();
    store.add(comment);

    expect(store.getCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'savePendingQueue',
      pending: [comment],
    });
  });

  it('remove: add 2, remove first → getCount = 1, remaining is second', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const first = makeComment({ tempId: 'first' });
    const second = makeComment({ tempId: 'second' });
    store.add(first);
    store.add(second);

    store.remove('first');

    expect(store.getCount()).toBe(1);
    expect(store.getAll()).toEqual([second]);
  });

  it('remove non-existent: remove("bogus") → no error, count unchanged, listener called', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);
    const listener = vi.fn();
    store.onChange(listener);

    const comment = makeComment({ tempId: 'real' });
    store.add(comment);
    listener.mockClear();

    store.remove('bogus');

    expect(store.getCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear: add 3, clear → getCount = 0, savePendingQueue sent with empty array', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    store.add(makeComment());
    store.add(makeComment());
    store.add(makeComment());
    vscode.postMessage.mockClear();

    store.clear();

    expect(store.getCount()).toBe(0);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'savePendingQueue',
      pending: [],
    });
  });

  it('clearSuccessful partial: add A,B,C → clearSuccessful(["B"]) → only B remains', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const a = makeComment({ tempId: 'A' });
    const b = makeComment({ tempId: 'B' });
    const c = makeComment({ tempId: 'C' });
    store.add(a);
    store.add(b);
    store.add(c);

    store.clearSuccessful(['B']);

    expect(store.getCount()).toBe(1);
    expect(store.getAll()).toEqual([b]);
  });

  it('clearSuccessful all failed: add A,B → clearSuccessful(["A","B"]) → both remain', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const a = makeComment({ tempId: 'A' });
    const b = makeComment({ tempId: 'B' });
    store.add(a);
    store.add(b);

    store.clearSuccessful(['A', 'B']);

    expect(store.getCount()).toBe(2);
    expect(store.getAll()).toEqual([a, b]);
  });

  it('clearSuccessful none failed: add A,B → clearSuccessful([]) → all cleared', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    store.add(makeComment({ tempId: 'A' }));
    store.add(makeComment({ tempId: 'B' }));

    store.clearSuccessful([]);

    expect(store.getCount()).toBe(0);
  });

  it('hydrate: hydrate([c1, c2]) → getCount = 2, listener called, savePendingQueue NOT sent', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);
    const listener = vi.fn();
    store.onChange(listener);

    const c1 = makeComment({ tempId: 'c1' });
    const c2 = makeComment({ tempId: 'c2' });
    store.hydrate([c1, c2]);

    expect(store.getCount()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vscode.postMessage).not.toHaveBeenCalled();
  });

  it('hydrate then add: hydrate([c1]), add(c2) → getCount = 2, savePendingQueue sent only for add', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const c1 = makeComment({ tempId: 'c1' });
    const c2 = makeComment({ tempId: 'c2' });

    store.hydrate([c1]);
    expect(vscode.postMessage).not.toHaveBeenCalled();

    store.add(c2);
    expect(store.getCount()).toBe(2);
    expect(vscode.postMessage).toHaveBeenCalledTimes(1);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'savePendingQueue',
      pending: [c1, c2],
    });
  });

  it('unsubscribe: subscribe, unsubscribe, add → listener NOT called after unsubscribe', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);
    const listener = vi.fn();

    const unsubscribe = store.onChange(listener);
    unsubscribe();

    store.add(makeComment());

    expect(listener).not.toHaveBeenCalled();
  });

  it('getAll returns copy: getAll(), mutate returned array → internal unaffected', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const comment = makeComment({ tempId: 'original' });
    store.add(comment);

    const copy = store.getAll();
    copy.push(makeComment({ tempId: 'injected' }));

    expect(store.getCount()).toBe(1);
    expect(store.getAll()).toEqual([comment]);
  });

  it('get found: add with tempId "abc", get("abc") → returns comment', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    const comment = makeComment({ tempId: 'abc' });
    store.add(comment);

    expect(store.get('abc')).toEqual(comment);
  });

  it('get not found: get("nonexistent") → undefined', () => {
    const vscode = makeVscode();
    const store = new PendingCommentStore(vscode);

    expect(store.get('nonexistent')).toBeUndefined();
  });
});
