vi.mock('vscode', () => ({
  Range: vi.fn(),
  WorkspaceEdit: vi.fn(),
  workspace: {
    applyEdit: vi.fn(),
    getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: '/workspace' } }),
    asRelativePath: vi.fn().mockReturnValue('src/test.md'),
  },
  commands: { executeCommand: vi.fn() },
  Uri: {
    joinPath: vi.fn(),
    file: vi.fn((p: string) => ({ fsPath: p, toString: () => `file://${p}` })),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../gh/ghCli', () => ({
  isGhAvailable: vi.fn(),
  isGhAuthenticated: vi.fn(),
  GhNotFoundError: class GhNotFoundError extends Error {
    constructor() {
      super('gh not found');
      this.name = 'GhNotFoundError';
    }
  },
  GhAuthError: class GhAuthError extends Error {
    constructor() {
      super('gh not authed');
      this.name = 'GhAuthError';
    }
  },
  GhApiError: class GhApiError extends Error {
    readonly stderr: string;
    readonly exitCode: number;
    constructor(message: string, stderr: string, exitCode: number) {
      super(message);
      this.name = 'GhApiError';
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
  },
  classifyGhError: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('../../gh/prDetector', () => ({
  detectPr: vi.fn(),
  openPrInBrowser: vi.fn(),
}));

vi.mock('../../gh/commentFetcher', () => ({
  fetchComments: vi.fn(),
  fetchPendingReviewComments: vi.fn(),
  fetchCurrentUser: vi.fn(),
}));

vi.mock('../../gh/commentPoster', () => ({
  submitReviewBatch: vi.fn(),
  getLatestCommitSha: vi.fn(),
}));

vi.mock('../../gh/diffLineMapper', () => ({
  fetchDiff: vi.fn(),
  parseDiffForFile: vi.fn(),
  validateMultiLineMapping: vi.fn(),
}));

import { execFile } from 'child_process';
import { CommentHandler } from '../../gh/commentHandler';
import { isGhAvailable, isGhAuthenticated, GhApiError } from '../../gh/ghCli';
import { detectPr, openPrInBrowser } from '../../gh/prDetector';
import { fetchComments, fetchPendingReviewComments, fetchCurrentUser } from '../../gh/commentFetcher';
import { submitReviewBatch, getLatestCommitSha } from '../../gh/commentPoster';
import { fetchDiff, parseDiffForFile, validateMultiLineMapping } from '../../gh/diffLineMapper';
import type { PrInfo, LineMapping, PendingComment } from '../../sync/commentTypes';

function makeWebview() {
  return { postMessage: vi.fn() };
}

function makeContext(savedPending: PendingComment[] | undefined = undefined) {
  return {
    workspaceState: {
      get: vi.fn().mockReturnValue(savedPending),
      update: vi.fn().mockResolvedValue(undefined),
    },
    extensionUri: { fsPath: '/ext' },
  };
}

function makeDocumentUri() {
  return {
    fsPath: '/workspace/src/test.md',
    toString: () => 'file:///workspace/src/test.md',
  };
}

function makePrInfo(): PrInfo {
  return {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
    headRefName: 'feat/test',
    baseRefName: 'main',
    owner: 'owner',
    repo: 'repo',
  };
}

function makeLineMapping(hasAddedLines = true): LineMapping {
  const diffLineToWorkingCopy = new Map<number, number>();
  const workingCopyToDiffLine = new Map<number, number>();

  if (hasAddedLines) {
    diffLineToWorkingCopy.set(5, 10);
    diffLineToWorkingCopy.set(6, 11);
    workingCopyToDiffLine.set(10, 5);
    workingCopyToDiffLine.set(11, 6);
  }

  return {
    diffLineToWorkingCopy,
    workingCopyToDiffLine,
    addedLines: hasAddedLines
      ? [
          { lineNumber: 10, type: 'added' },
          { lineNumber: 11, type: 'added' },
        ]
      : [],
  };
}

/**
 * Sets up execFile mock so git diff and git log return clean (empty) results.
 */
function mockGitClean() {
  vi.mocked(execFile).mockImplementation(
    ((_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      cb(null, '', '');
    }) as any,
  );
}

/**
 * Sets up execFile mock so git diff returns non-empty output (dirty file).
 */
function mockGitDirtyUncommitted() {
  vi.mocked(execFile).mockImplementation(
    ((_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      const argArr = args as string[];
      if (argArr[0] === 'diff') {
        cb(null, 'diff --git a/file b/file\n+added line', '');
      } else {
        cb(null, '', '');
      }
    }) as any,
  );
}

/**
 * Sets up execFile mock so git log returns non-empty output (unpushed commits).
 */
function mockGitDirtyUnpushed() {
  vi.mocked(execFile).mockImplementation(
    ((_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      const argArr = args as string[];
      if (argArr[0] === 'log') {
        cb(null, 'commit abc123\nAuthor: test', '');
      } else {
        cb(null, '', '');
      }
    }) as any,
  );
}

/**
 * Sets up all mocks for a successful toggle-on flow.
 */
function setupHappyPath(prInfo?: PrInfo, mapping?: LineMapping) {
  const pr = prInfo ?? makePrInfo();
  const lm = mapping ?? makeLineMapping();

  mockGitClean();
  vi.mocked(isGhAvailable).mockResolvedValue(true);
  vi.mocked(isGhAuthenticated).mockResolvedValue(true);
  vi.mocked(detectPr).mockResolvedValue(pr);
  vi.mocked(fetchDiff).mockResolvedValue('diff output');
  vi.mocked(fetchCurrentUser).mockResolvedValue('testuser');
  vi.mocked(parseDiffForFile).mockReturnValue(lm);
  vi.mocked(fetchComments).mockResolvedValue([]);
  vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CommentHandler', () => {
  describe('handleCommentToggle — enabled=true', () => {
    it('sends commentData on happy path (clean file, gh ok, PR exists)', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      setupHappyPath();

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentData',
          prNumber: 42,
          currentUser: 'testuser',
        }),
      );
    });

    it('sends commentError when file has uncommitted changes', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitDirtyUncommitted();

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('uncommitted'),
        }),
      );
      expect(isGhAvailable).not.toHaveBeenCalled();
    });

    it('sends commentError when file has unpushed commits', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitDirtyUnpushed();

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('unpushed'),
        }),
      );
      expect(isGhAvailable).not.toHaveBeenCalled();
    });

    it('sends commentError when gh is not available', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(false);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('not installed'),
        }),
      );
      expect(isGhAuthenticated).not.toHaveBeenCalled();
    });

    it('sends commentError when gh is not authenticated', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(false);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('not authenticated'),
        }),
      );
      expect(detectPr).not.toHaveBeenCalled();
    });

    it('sends commentError when no PR found', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(true);
      vi.mocked(detectPr).mockResolvedValue(null);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('No open PR'),
        }),
      );
    });

    it('sends commentError when file is not in diff', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      const emptyMapping = makeLineMapping(false);
      setupHappyPath(undefined, emptyMapping);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('no changes'),
        }),
      );
    });

    it('sends savedPendingQueue from workspaceState when non-empty', async () => {
      const savedPending: PendingComment[] = [
        {
          tempId: 'temp-1',
          threadId: null,
          body: 'saved comment',
          workingCopyLine: 10,
          workingCopyStartLine: null,
          diffLine: 5,
          diffStartLine: null,
        },
      ];
      const webview = makeWebview();
      const ctx = makeContext(savedPending);
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      setupHappyPath();

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      const calls = webview.postMessage.mock.calls;
      const pendingMsg = calls.find((c: any[]) => c[0].type === 'savedPendingQueue');
      expect(pendingMsg).toBeDefined();
      expect(pendingMsg![0].pending).toEqual(savedPending);
    });

    it('does not send savedPendingQueue when workspaceState is empty', async () => {
      const webview = makeWebview();
      const ctx = makeContext(undefined);
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      setupHappyPath();

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      const calls = webview.postMessage.mock.calls;
      const pendingMsg = calls.find((c: any[]) => c[0].type === 'savedPendingQueue');
      expect(pendingMsg).toBeUndefined();
    });

    it('sends commentError when fetchDiff rejects with GhApiError', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(true);
      vi.mocked(detectPr).mockResolvedValue(makePrInfo());
      vi.mocked(fetchDiff).mockRejectedValue(
        new GhApiError('API rate limit exceeded', 'rate limit stderr', 1),
      );

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('API rate limit exceeded'),
        }),
      );
    });

    it('sends commentError when fetchComments rejects', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(true);
      vi.mocked(detectPr).mockResolvedValue(makePrInfo());
      vi.mocked(fetchDiff).mockResolvedValue('diff output');
      vi.mocked(fetchCurrentUser).mockResolvedValue('testuser');
      vi.mocked(parseDiffForFile).mockReturnValue(makeLineMapping());
      vi.mocked(fetchComments).mockRejectedValue(new Error('Network timeout'));
      vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentError',
          message: expect.stringContaining('Network timeout'),
        }),
      );
    });

    it('does not send commentData when fetch fails (reviewModeActive stays false)', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      mockGitClean();
      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(true);
      vi.mocked(detectPr).mockResolvedValue(makePrInfo());
      vi.mocked(fetchDiff).mockRejectedValue(new Error('connection refused'));

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      const calls = webview.postMessage.mock.calls;
      const commentDataMsg = calls.find((c: any[]) => c[0].type === 'commentData');
      expect(commentDataMsg).toBeUndefined();

      // Verify review mode is not active by attempting a refresh —
      // handleCommentRefresh does nothing when reviewModeActive is false
      // (it checks cachedPrInfo and cachedCurrentUser, which won't be set
      // since fetchDiff failed before cachedCurrentUser could be assigned).
      vi.clearAllMocks();
      await handler.handleCommentRefresh();
      expect(fetchDiff).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleCommentToggle — enabled=false', () => {
    it('clears cached state', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // First enable to populate cache
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      // Now disable
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: false });

      // After disabling, validateLine should report no mapping
      handler.handleValidateLine({
        type: 'validateLine',
        tempId: 'test-1',
        workingCopyLine: 10,
        workingCopyStartLine: null,
      });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'lineMappingResult',
          tempId: 'test-1',
          diffLine: null,
          error: 'No line mapping available',
        }),
      );
    });
  });

  describe('handleCommentRefresh', () => {
    it('re-fetches and sends updated commentData', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // Enable first to populate cached PR info
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      // Set up refresh mocks
      const updatedMapping = makeLineMapping();
      vi.mocked(fetchDiff).mockResolvedValue('new diff');
      vi.mocked(parseDiffForFile).mockReturnValue(updatedMapping);
      vi.mocked(fetchComments).mockResolvedValue([
        {
          id: 1,
          path: 'src/test.md',
          diffLine: 5,
          diffStartLine: null,
          workingCopyLine: 10,
          workingCopyStartLine: null,
          comments: [
            {
              id: 100,
              author: 'reviewer',
              body: 'Looks good',
              createdAt: '2026-01-01T00:00:00Z',
              isOwn: false,
              isOutdated: false,
              isPending: false,
            },
          ],
        },
      ]);
      vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);

      await handler.handleCommentRefresh();

      expect(fetchDiff).toHaveBeenCalledOnce();
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'commentData',
          threads: expect.arrayContaining([
            expect.objectContaining({ id: 1 }),
          ]),
        }),
      );
    });

    it('does nothing when no cached PR info', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      await handler.handleCommentRefresh();

      expect(fetchDiff).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleCommentOpenPr', () => {
    it('calls openPrInBrowser', () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      handler.handleCommentOpenPr();

      expect(openPrInBrowser).toHaveBeenCalledWith('/workspace');
    });
  });

  describe('handleValidateLine', () => {
    it('sends lineMappingResult with diffLine when mapping exists', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // Enable to populate mapping cache
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      vi.mocked(validateMultiLineMapping).mockReturnValue({
        diffLine: 5,
        diffStartLine: null,
      });

      handler.handleValidateLine({
        type: 'validateLine',
        tempId: 'temp-1',
        workingCopyLine: 10,
        workingCopyStartLine: null,
      });

      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'lineMappingResult',
        tempId: 'temp-1',
        diffLine: 5,
        diffStartLine: null,
      });
    });

    it('sends lineMappingResult with null when no mapping cached', () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      handler.handleValidateLine({
        type: 'validateLine',
        tempId: 'temp-2',
        workingCopyLine: 99,
        workingCopyStartLine: null,
      });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'lineMappingResult',
          tempId: 'temp-2',
          diffLine: null,
          diffStartLine: null,
          error: 'No line mapping available',
        }),
      );
    });
  });

  describe('handleSubmitReview', () => {
    it('submits successfully and triggers refresh', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // Enable first
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      // Set up submit mocks
      vi.mocked(getLatestCommitSha).mockResolvedValue('abc123');
      vi.mocked(fetchDiff).mockResolvedValue('diff output');
      vi.mocked(parseDiffForFile).mockReturnValue(makeLineMapping());
      vi.mocked(validateMultiLineMapping).mockReturnValue({ diffLine: 5, diffStartLine: null });
      vi.mocked(submitReviewBatch).mockResolvedValue({ success: true });
      vi.mocked(fetchComments).mockResolvedValue([]);
      vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);

      const pending: PendingComment[] = [
        {
          tempId: 'new-1',
          threadId: null,
          body: 'New comment',
          workingCopyLine: 10,
          workingCopyStartLine: null,
          diffLine: null,
          diffStartLine: null,
        },
      ];

      await handler.handleSubmitReview({ type: 'submitReview', pending });

      expect(submitReviewBatch).toHaveBeenCalledOnce();
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reviewSubmitResult',
          success: true,
        }),
      );
      // Should also auto-refresh
      expect(fetchDiff).toHaveBeenCalledTimes(2); // once for validation, once for refresh
    });

    it('sends failure result when submitReviewBatch fails', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // Enable first
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      vi.mocked(getLatestCommitSha).mockResolvedValue('abc123');
      vi.mocked(fetchDiff).mockResolvedValue('diff output');
      vi.mocked(parseDiffForFile).mockReturnValue(makeLineMapping());
      vi.mocked(validateMultiLineMapping).mockReturnValue({ diffLine: 5, diffStartLine: null });
      vi.mocked(submitReviewBatch).mockResolvedValue({
        success: false,
        error: 'Permission denied',
        failedReplyIds: ['reply-1'],
      });

      const pending: PendingComment[] = [
        {
          tempId: 'new-1',
          threadId: null,
          body: 'New comment',
          workingCopyLine: 10,
          workingCopyStartLine: null,
          diffLine: null,
          diffStartLine: null,
        },
      ];

      await handler.handleSubmitReview({ type: 'submitReview', pending });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reviewSubmitResult',
          success: false,
          error: 'Permission denied',
        }),
      );
    });

    it('sends error when no cached PR info', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      await handler.handleSubmitReview({
        type: 'submitReview',
        pending: [],
      });

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reviewSubmitResult',
          success: false,
          error: expect.stringContaining('No PR information'),
        }),
      );
    });

    it('handles replies separately from new comments', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // Enable first
      setupHappyPath();
      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });
      vi.clearAllMocks();

      vi.mocked(getLatestCommitSha).mockResolvedValue('abc123');
      vi.mocked(fetchDiff).mockResolvedValue('diff output');
      vi.mocked(parseDiffForFile).mockReturnValue(makeLineMapping());
      vi.mocked(validateMultiLineMapping).mockReturnValue({ diffLine: 5, diffStartLine: null });
      vi.mocked(submitReviewBatch).mockResolvedValue({ success: true });
      vi.mocked(fetchComments).mockResolvedValue([]);
      vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);

      const pending: PendingComment[] = [
        {
          tempId: 'new-1',
          threadId: null,
          body: 'New comment',
          workingCopyLine: 10,
          workingCopyStartLine: null,
          diffLine: null,
          diffStartLine: null,
        },
        {
          tempId: 'reply-1',
          threadId: 999,
          body: 'Reply to thread',
          workingCopyLine: 10,
          workingCopyStartLine: null,
          diffLine: 5,
          diffStartLine: null,
        },
      ];

      await handler.handleSubmitReview({ type: 'submitReview', pending });

      const submitCall = vi.mocked(submitReviewBatch).mock.calls[0];
      const newComments = submitCall[1];
      const replies = submitCall[2];

      expect(newComments).toHaveLength(1);
      expect(newComments[0].threadId).toBeNull();
      expect(replies).toHaveLength(1);
      expect(replies[0].threadId).toBe(999);
    });
  });

  describe('handleSavePendingQueue', () => {
    it('writes pending comments to workspaceState', () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      const pending: PendingComment[] = [
        {
          tempId: 'p-1',
          threadId: null,
          body: 'Draft comment',
          workingCopyLine: 5,
          workingCopyStartLine: null,
          diffLine: null,
          diffStartLine: null,
        },
      ];

      handler.handleSavePendingQueue({ type: 'savePendingQueue', pending });

      expect(ctx.workspaceState.update).toHaveBeenCalledWith('pendingComments', pending);
    });
  });

  describe('git log error handling', () => {
    it('skips unpushed check when git log fails (no upstream)', async () => {
      const webview = makeWebview();
      const ctx = makeContext();
      const handler = new CommentHandler(webview as any, ctx as any, makeDocumentUri() as any, '/workspace');

      // git diff returns clean, but git log errors out (no upstream)
      vi.mocked(execFile).mockImplementation(
        ((_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
          const argArr = args as string[];
          if (argArr[0] === 'log') {
            cb(new Error('fatal: no upstream configured'), '', 'fatal: no upstream configured');
          } else {
            cb(null, '', '');
          }
        }) as any,
      );

      vi.mocked(isGhAvailable).mockResolvedValue(true);
      vi.mocked(isGhAuthenticated).mockResolvedValue(true);
      vi.mocked(detectPr).mockResolvedValue(makePrInfo());
      vi.mocked(fetchDiff).mockResolvedValue('diff output');
      vi.mocked(fetchCurrentUser).mockResolvedValue('testuser');
      vi.mocked(parseDiffForFile).mockReturnValue(makeLineMapping());
      vi.mocked(fetchComments).mockResolvedValue([]);
      vi.mocked(fetchPendingReviewComments).mockResolvedValue([]);

      await handler.handleCommentToggle({ type: 'commentToggle', enabled: true });

      // Should proceed past the dirty check and send commentData
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'commentData' }),
      );
    });
  });
});
