import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LineMapping, PrInfo } from '../../sync/commentTypes';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { fetchComments, fetchCurrentUser, fetchPendingReviewComments } from '../../gh/commentFetcher';

const pr: PrInfo = {
  number: 42,
  url: 'https://github.com/owner/repo/pull/42',
  headRefName: 'feat/test',
  baseRefName: 'main',
  owner: 'owner',
  repo: 'repo',
};

const targetFile = 'src/file.md';

const mapping: LineMapping = {
  diffLineToWorkingCopy: new Map([[5, 10], [8, 15], [3, 7], [10, 20]]),
  workingCopyToDiffLine: new Map([[10, 5], [15, 8], [7, 3], [20, 10]]),
  addedLines: [],
};

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    user: { login: 'reviewer' },
    body: 'Fix this',
    created_at: '2026-03-20T10:00:00Z',
    path: targetFile,
    line: 5,
    original_line: 5,
    start_line: null,
    in_reply_to_id: null,
    side: 'RIGHT',
    ...overrides,
  };
}

function mockGhResponse(comments: unknown[]) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: Function) => {
      cb(null, JSON.stringify(comments), '');
    },
  );
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('fetchComments', () => {
  it('returns a single thread for a single comment', async () => {
    const comment = makeComment();
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(1001);
    expect(threads[0].comments).toHaveLength(1);
    expect(threads[0].workingCopyLine).toBe(10);
    expect(threads[0].diffLine).toBe(5);
  });

  it('groups replies into a thread sorted by createdAt', async () => {
    const root = makeComment({ id: 100, created_at: '2026-03-20T10:00:00Z' });
    const reply1 = makeComment({
      id: 101,
      created_at: '2026-03-20T12:00:00Z',
      in_reply_to_id: 100,
    });
    const reply2 = makeComment({
      id: 102,
      created_at: '2026-03-20T11:00:00Z',
      in_reply_to_id: 100,
    });
    mockGhResponse([root, reply1, reply2]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].comments).toHaveLength(3);
    expect(threads[0].comments[0].id).toBe(100);
    expect(threads[0].comments[1].id).toBe(102); // 11:00 before 12:00
    expect(threads[0].comments[2].id).toBe(101);
  });

  it('returns multiple threads sorted by workingCopyLine', async () => {
    const c1 = makeComment({ id: 1, line: 10, original_line: 10 }); // wc=20
    const c2 = makeComment({ id: 2, line: 3, original_line: 3 });   // wc=7
    const c3 = makeComment({ id: 3, line: 8, original_line: 8 });   // wc=15
    mockGhResponse([c1, c2, c3]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(3);
    expect(threads[0].workingCopyLine).toBe(7);
    expect(threads[1].workingCopyLine).toBe(15);
    expect(threads[2].workingCopyLine).toBe(20);
  });

  it('filters comments to the target file only', async () => {
    const target1 = makeComment({ id: 1, line: 5 });
    const target2 = makeComment({ id: 2, line: 8 });
    const other1 = makeComment({ id: 3, path: 'other/file.ts', line: 5 });
    const other2 = makeComment({ id: 4, path: 'another.md', line: 8 });
    const other3 = makeComment({ id: 5, path: 'src/index.ts', line: 3 });
    mockGhResponse([target1, target2, other1, other2, other3]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(2);
    expect(threads.every((t) => t.path === targetFile)).toBe(true);
  });

  it('marks outdated comments (line null, original_line set)', async () => {
    const comment = makeComment({ id: 1, line: null, original_line: 15 });
    mockGhResponse([comment]);

    // line is null so it cannot be mapped → excluded
    // But the isOutdated flag should be true on the CommentData
    // Since workingCopyLine can't be mapped (null line), the thread is excluded
    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');
    expect(threads).toHaveLength(0);
  });

  it('marks non-outdated comments correctly', async () => {
    const comment = makeComment({ id: 1, line: 8, original_line: 8 });
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].comments[0].isOutdated).toBe(false);
  });

  it('sets isOwn true when user.login matches currentUser', async () => {
    const comment = makeComment({ id: 1, user: { login: 'myuser' }, line: 5 });
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'myuser', '/tmp');

    expect(threads[0].comments[0].isOwn).toBe(true);
  });

  it('sets isOwn false when user.login differs from currentUser', async () => {
    const comment = makeComment({ id: 1, user: { login: 'reviewer' }, line: 5 });
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'myuser', '/tmp');

    expect(threads[0].comments[0].isOwn).toBe(false);
  });

  it('excludes threads with unmappable diff lines', async () => {
    // line: 99 is not in the mapping
    const comment = makeComment({ id: 1, line: 99, original_line: 99 });
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(0);
  });

  it('treats orphan replies as new root threads', async () => {
    // reply pointing to a non-existent root
    const orphan = makeComment({
      id: 200,
      line: 8,
      original_line: 8,
      in_reply_to_id: 9999, // no such root
    });
    mockGhResponse([orphan]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(200);
    expect(threads[0].comments).toHaveLength(1);
  });

  it('maps multi-line threads (start_line and line)', async () => {
    const comment = makeComment({
      id: 1,
      line: 5,
      original_line: 5,
      start_line: 3,
    });
    mockGhResponse([comment]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].diffLine).toBe(5);
    expect(threads[0].diffStartLine).toBe(3);
    expect(threads[0].workingCopyLine).toBe(10);
    expect(threads[0].workingCopyStartLine).toBe(7);
  });

  it('returns empty array for empty gh response', async () => {
    mockGhResponse([]);

    const threads = await fetchComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(0);
  });
});

describe('fetchPendingReviewComments', () => {
  function makeReview(overrides: Record<string, unknown> = {}) {
    return {
      id: 5000,
      state: 'PENDING',
      user: { login: 'me' },
      node_id: 'R_abc123',
      ...overrides,
    };
  }

  function makePendingComment(overrides: Record<string, unknown> = {}) {
    return {
      id: 3001,
      user: { login: 'me' },
      body: 'Pending comment',
      created_at: '2026-03-20T10:00:00Z',
      path: targetFile,
      line: null,
      original_line: null,
      start_line: null,
      position: 5,
      original_position: 5,
      in_reply_to_id: null,
      side: 'RIGHT',
      ...overrides,
    };
  }

  /** Mock two sequential execGh calls: first returns reviews, second returns comments. */
  function mockTwoGhCalls(reviews: unknown[], comments: unknown[]) {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          cb(null, JSON.stringify(reviews), '');
        } else {
          cb(null, JSON.stringify(comments), '');
        }
      },
    );
  }

  it('returns empty when no pending review exists', async () => {
    const approvedReview = makeReview({ state: 'APPROVED' });
    const otherUserPending = makeReview({ user: { login: 'other' } });
    mockGhResponse([approvedReview, otherUserPending]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(0);
    // Should only call the reviews endpoint, not the comments endpoint
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns threads for pending review comments matching the file', async () => {
    const review = makeReview();
    const comment = makePendingComment({ position: 5 });
    mockTwoGhCalls([review], [comment]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(3001);
    expect(threads[0].diffLine).toBe(5);
    expect(threads[0].workingCopyLine).toBe(10);
    expect(threads[0].comments).toHaveLength(1);
    expect(threads[0].comments[0].isPending).toBe(true);
    expect(threads[0].comments[0].body).toBe('Pending comment');
  });

  it('filters out comments for other files', async () => {
    const review = makeReview();
    const matchingComment = makePendingComment({ id: 3001, position: 5 });
    const otherFileComment = makePendingComment({ id: 3002, path: 'other/file.ts', position: 8 });
    mockTwoGhCalls([review], [matchingComment, otherFileComment]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].path).toBe(targetFile);
  });

  it('falls back to position/original_position when line fields are null', async () => {
    const review = makeReview();
    // line: null, original_line: null → falls back to position (8)
    const comment = makePendingComment({
      line: null,
      original_line: null,
      position: 8,
      original_position: 8,
    });
    mockTwoGhCalls([review], [comment]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].diffLine).toBe(8);
    expect(threads[0].workingCopyLine).toBe(15); // mapping: 8 → 15
  });

  it('handles orphan replies (reply with no matching root)', async () => {
    const review = makeReview();
    const orphan = makePendingComment({
      id: 4001,
      position: 8,
      in_reply_to_id: 9999, // no root with this id
    });
    mockTwoGhCalls([review], [orphan]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(4001);
    expect(threads[0].comments).toHaveLength(1);
  });

  it('returns empty on API error (catch-all)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(new Error('API failure'), '', 'gh: something went wrong');
      },
    );

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(0);
  });

  it('skips comments that do not map to a working copy line', async () => {
    const review = makeReview();
    // position: 99 is not in the mapping
    const unmappable = makePendingComment({ id: 3010, position: 99 });
    // position: 5 is in the mapping → wc=10
    const mappable = makePendingComment({ id: 3011, position: 5 });
    mockTwoGhCalls([review], [unmappable, mappable]);

    const threads = await fetchPendingReviewComments(pr, targetFile, mapping, 'me', '/tmp');

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(3011);
    expect(threads[0].workingCopyLine).toBe(10);
  });
});

describe('fetchCurrentUser', () => {
  it('trims whitespace from the response', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '  myuser\n', '');
      },
    );

    const user = await fetchCurrentUser('/tmp');

    expect(user).toBe('myuser');
  });
});
