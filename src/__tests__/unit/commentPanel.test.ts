// @vitest-environment happy-dom

import type { CommentThread, PendingComment } from '../../sync/commentTypes';
import { PendingCommentStore } from '../../webview/pendingCommentStore';
import { CommentPanel } from '../../webview/commentPanel';

function makeVsCodeApi() {
  return { postMessage: vi.fn() };
}

function makeAnchorEl(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  // happy-dom getBoundingClientRect returns zeroes; that's fine for positioning tests
  return el;
}

function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 1,
    path: 'README.md',
    diffLine: 10,
    diffStartLine: null,
    workingCopyLine: 10,
    workingCopyStartLine: null,
    comments: [
      {
        id: 100,
        author: 'alice',
        body: 'Looks good!',
        createdAt: new Date(Date.now() - 5 * 60000).toISOString(), // 5 min ago
        isOwn: false,
        isOutdated: false,
      },
    ],
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingComment> = {}): PendingComment {
  return {
    tempId: 'temp-1',
    threadId: null,
    body: 'pending comment',
    workingCopyLine: 10,
    workingCopyStartLine: null,
    diffLine: null,
    diffStartLine: null,
    ...overrides,
  };
}

describe('CommentPanel', () => {
  let container: HTMLElement;
  let vscode: ReturnType<typeof makeVsCodeApi>;
  let store: PendingCommentStore;
  let panel: CommentPanel;
  let anchor: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vscode = makeVsCodeApi();
    store = new PendingCommentStore(vscode);
    panel = new CommentPanel(container, store, vscode);
    anchor = makeAnchorEl();
  });

  afterEach(() => {
    panel.dispose();
    container.remove();
    anchor.remove();
  });

  // 1. openThread creates panel with correct header (Line N)
  it('openThread creates panel with correct header', () => {
    const thread = makeThread({ workingCopyLine: 42 });
    panel.openThread(thread, anchor);

    const headerLine = container.querySelector('.comment-panel-line');
    expect(headerLine).not.toBeNull();
    expect(headerLine!.textContent).toBe('Line 42');
  });

  // 2. openThread renders comments with author, timestamp, body
  it('openThread renders comments with author, timestamp, body', () => {
    const thread = makeThread();
    panel.openThread(thread, anchor);

    const authorEl = container.querySelector('.comment-author');
    expect(authorEl).not.toBeNull();
    expect(authorEl!.textContent).toBe('@alice');

    const timestampEl = container.querySelector('.comment-timestamp');
    expect(timestampEl).not.toBeNull();
    expect(timestampEl!.textContent).toBe('5m ago');

    const bodyEl = container.querySelector('.comment-body');
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.textContent).toBe('Looks good!');
  });

  // 3. openThread renders outdated label for outdated comments
  it('openThread renders outdated label for outdated comments', () => {
    const thread = makeThread({
      comments: [
        {
          id: 200,
          author: 'bob',
          body: 'Old comment',
          createdAt: new Date().toISOString(),
          isOwn: false,
          isOutdated: true,
        },
      ],
    });
    panel.openThread(thread, anchor);

    const outdatedLabel = container.querySelector('.comment-outdated-label');
    expect(outdatedLabel).not.toBeNull();
    expect(outdatedLabel!.textContent).toBe('Outdated');

    const entry = container.querySelector('.comment-entry');
    expect(entry!.classList.contains('comment-entry-outdated')).toBe(true);
  });

  // 4. openNew creates panel with "New comment on Line N" header
  it('openNew creates panel with "New comment on Line N" header', () => {
    panel.openNew(15, null, anchor);

    const headerLine = container.querySelector('.comment-panel-line');
    expect(headerLine).not.toBeNull();
    expect(headerLine!.textContent).toBe('New comment on Line 15');
  });

  // 5. openNew with multi-line shows "New comment on Lines N-M" header
  it('openNew with multi-line shows "New comment on Lines N-M" header', () => {
    panel.openNew(20, 15, anchor);

    const headerLine = container.querySelector('.comment-panel-line');
    expect(headerLine).not.toBeNull();
    expect(headerLine!.textContent).toBe('New comment on Lines 15-20');
  });

  // 6. Close removes panel from DOM
  it('close removes panel from DOM', () => {
    panel.openNew(10, null, anchor);
    expect(container.querySelector('.comment-panel')).not.toBeNull();

    panel.close();
    expect(container.querySelector('.comment-panel')).toBeNull();
  });

  // 7. One panel at a time: openThread then openNew closes the first
  it('only one panel open at a time', () => {
    const thread = makeThread();
    panel.openThread(thread, anchor);
    expect(container.querySelectorAll('.comment-panel')).toHaveLength(1);

    panel.openNew(5, null, anchor);
    expect(container.querySelectorAll('.comment-panel')).toHaveLength(1);

    const headerLine = container.querySelector('.comment-panel-line');
    expect(headerLine!.textContent).toBe('New comment on Line 5');
  });

  // 8. Queue button adds pending comment to store and sends validateLine message
  it('queue button adds pending comment to store and sends validateLine', () => {
    panel.openNew(10, null, anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'My review comment';

    const queueBtn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    queueBtn.click();

    const allPending = store.getAll();
    expect(allPending).toHaveLength(1);
    expect(allPending[0].body).toBe('My review comment');
    expect(allPending[0].workingCopyLine).toBe(10);

    // vscode.postMessage is called by both the store (savePendingQueue) and the panel (validateLine)
    const validateCall = vscode.postMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type: string }).type === 'validateLine'
    );
    expect(validateCall).toBeDefined();
    expect((validateCall![0] as { workingCopyLine: number }).workingCopyLine).toBe(10);
  });

  // 9. Queue button clears textarea after adding
  it('queue button clears textarea after adding', () => {
    panel.openNew(10, null, anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'Some comment text';

    const queueBtn = container.querySelector('.comment-reply-queue') as HTMLButtonElement;
    queueBtn.click();

    expect(textarea.value).toBe('');
  });

  // 10. Discard button removes pending comment from store
  it('discard button removes pending comment from store', () => {
    store.add(makePending({ tempId: 'discard-me', workingCopyLine: 10 }));

    const thread = makeThread({ workingCopyLine: 10 });
    panel.openThread(thread, anchor);

    const discardBtn = container.querySelector('.comment-discard') as HTMLButtonElement;
    expect(discardBtn).not.toBeNull();
    discardBtn.click();

    expect(store.getAll()).toHaveLength(0);
  });

  // 11. Escape closes panel
  it('escape key closes panel', () => {
    panel.openNew(10, null, anchor);
    expect(panel.isOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isOpen()).toBe(false);
  });

  // 12. Escape does NOT close when textarea has text and is focused
  it('escape does not close when textarea has text and is focused', () => {
    panel.openNew(10, null, anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'work in progress';
    textarea.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isOpen()).toBe(true);
  });

  // 13. isOpen returns true when panel is open, false when closed
  it('isOpen reflects panel state', () => {
    expect(panel.isOpen()).toBe(false);

    panel.openNew(10, null, anchor);
    expect(panel.isOpen()).toBe(true);

    panel.close();
    expect(panel.isOpen()).toBe(false);
  });

  // 14. refresh preserves textarea text
  it('refresh preserves textarea text', () => {
    const thread = makeThread();
    panel.openThread(thread, anchor);

    const textarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    textarea.value = 'draft reply';

    panel.refresh(
      [makeThread({ comments: [
        { id: 100, author: 'alice', body: 'Updated!', createdAt: new Date().toISOString(), isOwn: false, isOutdated: false },
      ] })],
      []
    );

    const newTextarea = container.querySelector('.comment-reply-input') as HTMLTextAreaElement;
    expect(newTextarea.value).toBe('draft reply');
  });

  // 15. formatRelativeTime: "just now", "Nm ago", "Nh ago"
  describe('formatRelativeTime via rendered timestamps', () => {
    it('shows "just now" for <1 minute', () => {
      const thread = makeThread({
        comments: [
          { id: 1, author: 'a', body: 'x', createdAt: new Date().toISOString(), isOwn: false, isOutdated: false },
        ],
      });
      panel.openThread(thread, anchor);

      const timestamp = container.querySelector('.comment-timestamp');
      expect(timestamp!.textContent).toBe('just now');
    });

    it('shows "Nm ago" for minutes', () => {
      const thread = makeThread({
        comments: [
          { id: 1, author: 'a', body: 'x', createdAt: new Date(Date.now() - 30 * 60000).toISOString(), isOwn: false, isOutdated: false },
        ],
      });
      panel.openThread(thread, anchor);

      const timestamp = container.querySelector('.comment-timestamp');
      expect(timestamp!.textContent).toBe('30m ago');
    });

    it('shows "Nh ago" for hours', () => {
      const thread = makeThread({
        comments: [
          { id: 1, author: 'a', body: 'x', createdAt: new Date(Date.now() - 3 * 3600000).toISOString(), isOwn: false, isOutdated: false },
        ],
      });
      panel.openThread(thread, anchor);

      const timestamp = container.querySelector('.comment-timestamp');
      expect(timestamp!.textContent).toBe('3h ago');
    });

    it('shows "Nd ago" for days', () => {
      const thread = makeThread({
        comments: [
          { id: 1, author: 'a', body: 'x', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), isOwn: false, isOutdated: false },
        ],
      });
      panel.openThread(thread, anchor);

      const timestamp = container.querySelector('.comment-timestamp');
      expect(timestamp!.textContent).toBe('2d ago');
    });
  });
});
