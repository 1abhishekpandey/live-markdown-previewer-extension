import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrInfo, PendingComment } from '../../sync/commentTypes';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { submitReviewBatch, getLatestCommitSha } from '../../gh/commentPoster';
import { execFile } from 'child_process';

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

describe('commentPoster', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('logs formatted output for 2 new single-line comments and returns success', async () => {
    const c1 = makeComment({ tempId: 'c1', body: 'Fix this typo', diffLine: 8 });
    const c2 = makeComment({ tempId: 'c2', body: 'Rename variable', diffLine: 22 });

    const result = await submitReviewBatch(pr, [c1, c2], [], 'sha1', 'src/file.md', '/tmp');

    expect(result).toEqual({ success: true });
    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[new] src/file.md:8');
    expect(output).toContain('[new] src/file.md:22');
  });

  it('logs multi-line range when diffStartLine is set', async () => {
    const c = makeComment({ diffStartLine: 10, diffLine: 18, body: 'Multi-line comment' });

    await submitReviewBatch(pr, [c], [], 'sha1', 'src/file.md', '/tmp');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[new] src/file.md:10-18');
  });

  it('logs reply format for replies with threadId', async () => {
    const r1 = makeComment({ threadId: 456, body: 'Reply one' });
    const r2 = makeComment({ threadId: 789, body: 'Reply two' });

    await submitReviewBatch(pr, [], [r1, r2], 'sha1', 'src/file.md', '/tmp');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[reply] thread #456');
    expect(output).toContain('[reply] thread #789');
  });

  it('logs both new and reply for a mixed batch', async () => {
    const newComment = makeComment({ body: 'New comment' });
    const reply = makeComment({ threadId: 100, body: 'A reply' });

    await submitReviewBatch(pr, [newComment], [reply], 'sha1', 'src/file.md', '/tmp');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[new]');
    expect(output).toContain('[reply] thread #100');
  });

  it('returns success for an empty batch', async () => {
    const result = await submitReviewBatch(pr, [], [], 'sha1', 'src/file.md', '/tmp');

    expect(result).toEqual({ success: true });
    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('0 comments to PR #123');
  });

  it('includes PR number and correct format in log output', async () => {
    const c = makeComment({ body: 'Check this' });

    await submitReviewBatch(pr, [c], [], 'sha1', 'src/app.ts', '/tmp');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[LiveMarkdown] Submit Review');
    expect(output).toContain('PR #123');
    expect(output).toContain('1 comments to PR #123');
  });

  it('getLatestCommitSha returns trimmed SHA from gh api', async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, 'abc123def456\n', '');
      return undefined as any;
    });

    const sha = await getLatestCommitSha(pr, '/tmp');
    expect(sha).toBe('abc123def456');
  });

  it('getLatestCommitSha calls execGh with correct repo/PR path and --jq flag', async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, 'deadbeef\n', '');
      return undefined as any;
    });

    await getLatestCommitSha(pr, '/workspace');

    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/owner/repo/pulls/123', '--jq', '.head.sha'],
      { cwd: '/workspace' },
      expect.any(Function),
    );
  });

  it('truncates long comment bodies to 50 chars with ellipsis', async () => {
    const longBody = 'A'.repeat(120);
    const c = makeComment({ body: longBody });

    await submitReviewBatch(pr, [c], [], 'sha1', 'src/file.md', '/tmp');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('A'.repeat(50) + '...');
    expect(output).not.toContain('A'.repeat(51));
  });

  it('always returns success regardless of input', async () => {
    const unusual = makeComment({
      tempId: '',
      body: '',
      workingCopyLine: -1,
      diffLine: null,
    });

    const result = await submitReviewBatch(pr, [unusual], [], 'sha1', '', '/tmp');
    expect(result.success).toBe(true);
  });
});
