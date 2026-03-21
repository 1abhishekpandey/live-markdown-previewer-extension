import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrInfo, PendingComment } from '../../sync/commentTypes';

const mockStdin = { write: vi.fn(), end: vi.fn() };
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { submitReviewBatch, getLatestCommitSha } from '../../gh/commentPoster';

const pr: PrInfo = {
  number: 123,
  url: 'https://github.com/owner/repo/pull/123',
  headRefName: 'feat/test',
  baseRefName: 'main',
  owner: 'owner',
  repo: 'repo',
};

function makeComment(overrides: Partial<PendingComment> = {}): PendingComment {
  return {
    tempId: 'abc-123',
    threadId: null,
    body: 'Fix this typo',
    workingCopyLine: 15,
    workingCopyStartLine: null,
    diffLine: 8,
    diffStartLine: null,
    ...overrides,
  };
}

function isReviewsLookup(args: string[]): boolean {
  // findPendingReviewNodeId calls: gh api repos/.../reviews --jq '...'
  // POST calls: gh api --method POST repos/.../reviews --input -
  // Distinguish by checking if --method is present (POST) vs not (GET/lookup)
  return args.some((a: string) => a.includes('/reviews')) && !args.includes('--method');
}

function stubSuccess() {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: object, cb: Function) => {
      if (isReviewsLookup(args)) {
        cb(null, '', ''); // No pending review found
      } else {
        cb(null, '{}', '');
      }
      return { stdin: mockStdin };
    },
  );
}

function stubFailure(stderr: string, exitCode = 1) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: object, cb: Function) => {
      if (isReviewsLookup(args)) {
        cb(null, '', ''); // No pending review
      } else {
        const err = new Error('Command failed') as any;
        err.code = exitCode;
        cb(err, '', stderr);
      }
      return { stdin: mockStdin };
    },
  );
}

describe('commentPoster', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockStdin.write.mockReset();
    mockStdin.end.mockReset();
  });

  describe('submitReviewBatch — new comments', () => {
    it('posts a batch review with PENDING event for new comments', async () => {
      stubSuccess();
      const c1 = makeComment({ tempId: 'c1', body: 'Fix this typo', diffLine: 8 });
      const c2 = makeComment({ tempId: 'c2', body: 'Rename variable', diffLine: 22 });

      const result = await submitReviewBatch(pr, [c1, c2], [], 'sha1', 'src/file.md', '/tmp');

      expect(result).toEqual({ success: true });
      // 2 calls: findPendingReviewNodeId + POST review
      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // Find the stdin write that contains the review body (the POST call)
      const stdinPayload = JSON.parse(mockStdin.write.mock.calls[0][0]);
      expect(stdinPayload.commit_id).toBe('sha1');
      expect(stdinPayload.comments).toHaveLength(2);
      expect(stdinPayload.comments[0]).toEqual({
        path: 'src/file.md',
        line: 8,
        side: 'RIGHT',
        body: 'Fix this typo',
      });
      expect(stdinPayload.comments[1]).toEqual({
        path: 'src/file.md',
        line: 22,
        side: 'RIGHT',
        body: 'Rename variable',
      });
    });

    it('includes start_line and start_side for multi-line comments', async () => {
      stubSuccess();
      const c = makeComment({ diffStartLine: 10, diffLine: 18, body: 'Multi-line comment' });

      const result = await submitReviewBatch(pr, [c], [], 'sha1', 'src/file.md', '/tmp');

      expect(result).toEqual({ success: true });

      const stdinPayload = JSON.parse(mockStdin.write.mock.calls[0][0]);
      expect(stdinPayload.comments[0]).toEqual({
        path: 'src/file.md',
        line: 18,
        side: 'RIGHT',
        body: 'Multi-line comment',
        start_line: 10,
        start_side: 'RIGHT',
      });
    });
  });

  describe('submitReviewBatch — replies', () => {
    it('posts individual reply calls with in_reply_to', async () => {
      stubSuccess();
      const r1 = makeComment({ tempId: 'r1', threadId: 456, body: 'Reply one' });
      const r2 = makeComment({ tempId: 'r2', threadId: 789, body: 'Reply two' });

      const result = await submitReviewBatch(pr, [], [r1, r2], 'sha1', 'src/file.md', '/tmp');

      expect(result).toEqual({ success: true });
      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // Both calls should target the comments endpoint
      for (const call of mockExecFile.mock.calls) {
        expect(call[1]).toEqual([
          'api', '--method', 'POST', 'repos/owner/repo/pulls/123/comments', '--input', '-',
        ]);
      }

      // Verify stdin payloads for each reply
      const payload1 = JSON.parse(mockStdin.write.mock.calls[0][0]);
      expect(payload1).toEqual({ body: 'Reply one', in_reply_to: 456 });

      const payload2 = JSON.parse(mockStdin.write.mock.calls[1][0]);
      expect(payload2).toEqual({ body: 'Reply two', in_reply_to: 789 });
    });
  });

  describe('submitReviewBatch — mixed batch', () => {
    it('posts review first then replies', async () => {
      stubSuccess();
      const newComment = makeComment({ tempId: 'n1', body: 'New comment', diffLine: 5 });
      const reply = makeComment({ tempId: 'r1', threadId: 100, body: 'A reply' });

      const result = await submitReviewBatch(pr, [newComment], [reply], 'sha1', 'src/file.md', '/tmp');

      expect(result).toEqual({ success: true });
      // 3 calls: findPendingReviewNodeId + POST review + POST reply
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });
  });

  describe('submitReviewBatch — empty batch', () => {
    it('returns success without making any API calls', async () => {
      stubSuccess();

      const result = await submitReviewBatch(pr, [], [], 'sha1', 'src/file.md', '/tmp');

      expect(result).toEqual({ success: true });
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('submitReviewBatch — error handling', () => {
    it('returns error when review API fails', async () => {
      stubFailure('Validation Failed');
      const c = makeComment({ body: 'A comment' });

      const result = await submitReviewBatch(pr, [c], [], 'sha1', 'src/file.md', '/tmp');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create review');
      expect(result.error).toContain('Validation Failed');
    });

    it('returns failedReplyIds on partial reply failure', async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: Function) => {
          callCount++;
          if (callCount === 2) {
            const err = new Error('Command failed') as any;
            err.code = 1;
            cb(err, '', 'server error');
          } else {
            cb(null, '{}', '');
          }
          return { stdin: mockStdin };
        },
      );

      const r1 = makeComment({ tempId: 'r1', threadId: 456, body: 'Reply one' });
      const r2 = makeComment({ tempId: 'r2', threadId: 789, body: 'Reply two' });

      const result = await submitReviewBatch(pr, [], [r1, r2], 'sha1', 'src/file.md', '/tmp');

      expect(result.success).toBe(false);
      expect(result.failedReplyIds).toEqual(['r2']);
    });

    it('skips replies when review API fails for a mixed batch', async () => {
      stubFailure('Bad request');
      const newComment = makeComment({ body: 'New comment' });
      const reply = makeComment({ tempId: 'r1', threadId: 100, body: 'A reply' });

      const result = await submitReviewBatch(pr, [newComment], [reply], 'sha1', 'src/file.md', '/tmp');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create review');
      // 2 calls: findPendingReviewNodeId (succeeds with empty) + POST review (fails)
      // Reply is never attempted
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('getLatestCommitSha', () => {
    it('returns trimmed SHA from gh api', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: Function) => {
          cb(null, 'abc123def456\n', '');
          return { stdin: mockStdin };
        },
      );

      const sha = await getLatestCommitSha(pr, '/tmp');
      expect(sha).toBe('abc123def456');
    });

    it('calls execGh with correct repo/PR path and --jq flag', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: Function) => {
          cb(null, 'deadbeef\n', '');
          return { stdin: mockStdin };
        },
      );

      await getLatestCommitSha(pr, '/workspace');

      expect(mockExecFile).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/owner/repo/pulls/123', '--jq', '.head.sha'],
        { cwd: '/workspace' },
        expect.any(Function),
      );
    });
  });
});
