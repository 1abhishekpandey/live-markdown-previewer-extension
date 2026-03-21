import * as vscode from 'vscode';
import { execFile } from 'child_process';
import type { PrInfo, LineMapping, CommentThread, PendingComment } from '../sync/commentTypes';
import type {
  CommentToggleMessage,
  ValidateLineMessage,
  SubmitReviewMessage,
  SavePendingQueueMessage,
  CommentDataMessage,
  ReviewSubmitResultMessage,
  CommentErrorMessage,
  LineMappingResultMessage,
  SavedPendingQueueMessage,
} from '../sync/syncProtocol';
import { isGhAvailable, isGhAuthenticated, GhApiError, classifyGhError } from './ghCli';
import { detectPr, openPrInBrowser } from './prDetector';
import { fetchComments, fetchPendingReviewComments, fetchCurrentUser } from './commentFetcher';
import { submitReviewBatch, getLatestCommitSha } from './commentPoster';
import { fetchDiff, parseDiffForFile, validateMultiLineMapping } from './diffLineMapper';

const PENDING_COMMENTS_KEY = 'pendingComments';

export class CommentHandler {
  private cachedPrInfo: PrInfo | null = null;
  private cachedCurrentUser: string | null = null;
  private cachedLineMapping: LineMapping | null = null;
  private reviewModeActive: boolean = false;

  private readonly webview: vscode.Webview;
  private readonly context: vscode.ExtensionContext;
  private readonly documentUri: vscode.Uri;
  private readonly cwd: string;

  constructor(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    documentUri: vscode.Uri,
    cwd: string,
  ) {
    this.webview = webview;
    this.context = context;
    this.documentUri = documentUri;
    this.cwd = cwd;
  }

  async handleCommentToggle(msg: CommentToggleMessage): Promise<void> {
    if (!msg.enabled) {
      this.cachedLineMapping = null;
      this.reviewModeActive = false;
      return;
    }

    const filePath = this.getRelativePath();

    const isDirty = await this.checkDirtyFile(filePath);
    if (isDirty) return;

    const ghAvailable = await this.checkGhAvailable();
    if (!ghAvailable) return;

    const ghAuthed = await this.checkGhAuthenticated();
    if (!ghAuthed) return;

    const prInfo = await this.checkPrExists();
    if (!prInfo) return;

    this.cachedPrInfo = prInfo;

    const [diffOutput, currentUser] = await Promise.all([
      fetchDiff(prInfo, this.cwd),
      this.cachedCurrentUser
        ? Promise.resolve(this.cachedCurrentUser)
        : fetchCurrentUser(this.cwd),
    ]);

    this.cachedCurrentUser = currentUser;

    const lineMapping = parseDiffForFile(diffOutput, filePath);

    if (lineMapping.addedLines.length === 0) {
      this.sendError('This file has no changes in the current PR diff.');
      return;
    }

    this.cachedLineMapping = lineMapping;

    const [publishedThreads, pendingThreads] = await Promise.all([
      fetchComments(prInfo, filePath, lineMapping, currentUser, this.cwd),
      fetchPendingReviewComments(prInfo, filePath, lineMapping, currentUser, this.cwd),
    ]);
    const threads = [...publishedThreads, ...pendingThreads]
      .sort((a, b) => a.workingCopyLine - b.workingCopyLine);
    const diffHighlightLines = lineMapping.addedLines.map((l) => l.lineNumber);

    this.postMessage({
      type: 'commentData',
      threads,
      prNumber: prInfo.number,
      prUrl: prInfo.url,
      currentUser,
      diffHighlightLines,
      lastFetchedAt: Date.now(),
    } satisfies CommentDataMessage);

    const savedPending = this.context.workspaceState.get<PendingComment[]>(PENDING_COMMENTS_KEY);
    if (savedPending && savedPending.length > 0) {
      this.postMessage({
        type: 'savedPendingQueue',
        pending: savedPending,
      } satisfies SavedPendingQueueMessage);
    }

    this.reviewModeActive = true;
  }

  async handleCommentRefresh(): Promise<void> {
    if (!this.cachedPrInfo || !this.cachedCurrentUser) return;

    const filePath = this.getRelativePath();

    try {
      const diffOutput = await fetchDiff(this.cachedPrInfo, this.cwd);
      const lineMapping = parseDiffForFile(diffOutput, filePath);
      this.cachedLineMapping = lineMapping;

      const [publishedThreads, pendingThreads] = await Promise.all([
        fetchComments(
          this.cachedPrInfo,
          filePath,
          lineMapping,
          this.cachedCurrentUser,
          this.cwd,
        ),
        fetchPendingReviewComments(
          this.cachedPrInfo,
          filePath,
          lineMapping,
          this.cachedCurrentUser,
          this.cwd,
        ),
      ]);
      const threads = [...publishedThreads, ...pendingThreads]
        .sort((a, b) => a.workingCopyLine - b.workingCopyLine);

      const diffHighlightLines = lineMapping.addedLines.map((l) => l.lineNumber);

      this.postMessage({
        type: 'commentData',
        threads,
        prNumber: this.cachedPrInfo.number,
        prUrl: this.cachedPrInfo.url,
        currentUser: this.cachedCurrentUser,
        diffHighlightLines,
        lastFetchedAt: Date.now(),
      } satisfies CommentDataMessage);
    } catch (err) {
      this.handleGhError(err);
    }
  }

  handleCommentOpenPr(): void {
    openPrInBrowser(this.cwd);
  }

  handleValidateLine(msg: ValidateLineMessage): void {
    if (!this.cachedLineMapping) {
      this.postMessage({
        type: 'lineMappingResult',
        tempId: msg.tempId,
        diffLine: null,
        diffStartLine: null,
        error: 'No line mapping available',
      } satisfies LineMappingResultMessage);
      return;
    }

    const result = validateMultiLineMapping(
      msg.workingCopyLine,
      msg.workingCopyStartLine,
      this.cachedLineMapping,
    );

    this.postMessage({
      type: 'lineMappingResult',
      tempId: msg.tempId,
      diffLine: result.diffLine,
      diffStartLine: result.diffStartLine,
    } satisfies LineMappingResultMessage);
  }

  async handleSubmitReview(msg: SubmitReviewMessage): Promise<void> {
    if (!this.cachedPrInfo) {
      this.postMessage({
        type: 'reviewSubmitResult',
        success: false,
        error: 'No PR information cached. Please toggle review mode on first.',
      } satisfies ReviewSubmitResultMessage);
      return;
    }

    const filePath = this.getRelativePath();
    console.log('[LiveMarkdown] Submit review — cwd:', this.cwd, 'filePath:', filePath);
    console.log('[LiveMarkdown] Pending comments:', JSON.stringify(msg.pending, null, 2));

    const newComments = msg.pending.filter((c) => c.threadId === null);
    const replies = msg.pending.filter((c) => c.threadId !== null);
    console.log('[LiveMarkdown] New comments:', newComments.length, 'Replies:', replies.length);

    try {
      const commitSha = await getLatestCommitSha(this.cachedPrInfo, this.cwd);
      console.log('[LiveMarkdown] Commit SHA:', commitSha);

      const diffOutput = await fetchDiff(this.cachedPrInfo, this.cwd);
      const freshMapping = parseDiffForFile(diffOutput, filePath);
      console.log('[LiveMarkdown] Fresh mapping — addedLines:', freshMapping.addedLines.length, 'wcToDiff size:', freshMapping.workingCopyToDiffLine.size);

      const validatedNew: PendingComment[] = [];
      const failedIds: string[] = [];

      for (const comment of newComments) {
        const mapped = validateMultiLineMapping(
          comment.workingCopyLine,
          comment.workingCopyStartLine,
          freshMapping,
        );

        console.log(`[LiveMarkdown] Validate line ${comment.workingCopyLine} → diffLine: ${mapped.diffLine}`);
        if (mapped.diffLine === null) {
          failedIds.push(comment.tempId);
          continue;
        }

        validatedNew.push({
          ...comment,
          diffLine: mapped.diffLine,
          diffStartLine: mapped.diffStartLine,
        });
      }

      console.log('[LiveMarkdown] Validated:', validatedNew.length, 'Failed:', failedIds.length);

      if (failedIds.length > 0 && validatedNew.length === 0 && replies.length === 0) {
        this.postMessage({
          type: 'reviewSubmitResult',
          success: false,
          error: 'All new comments failed line validation against the latest diff.',
          failedReplyIds: failedIds,
        } satisfies ReviewSubmitResultMessage);
        return;
      }

      console.log('[LiveMarkdown] Calling submitReviewBatch...');
      const result = await submitReviewBatch(
        this.cachedPrInfo,
        validatedNew,
        replies,
        commitSha,
        filePath,
        this.cwd,
      );
      console.log('[LiveMarkdown] Submit result:', JSON.stringify(result));

      const submitResult: ReviewSubmitResultMessage = {
        type: 'reviewSubmitResult',
        success: result.success,
        error: result.error,
        failedReplyIds: [...failedIds, ...(result.failedReplyIds ?? [])],
      };

      this.postMessage(submitResult);

      if (result.success) {
        await this.handleCommentRefresh();
      }
    } catch (err) {
      this.handleGhError(err);
      this.postMessage({
        type: 'reviewSubmitResult',
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error during review submission',
      } satisfies ReviewSubmitResultMessage);
    }
  }

  handleSavePendingQueue(msg: SavePendingQueueMessage): void {
    this.context.workspaceState.update(PENDING_COMMENTS_KEY, msg.pending);
  }

  private getRelativePath(): string {
    return vscode.workspace.asRelativePath(this.documentUri, false);
  }

  private async checkDirtyFile(filePath: string): Promise<boolean> {
    const hasUncommitted = await this.execGit(['diff', 'HEAD', '--', filePath]);
    if (hasUncommitted) {
      this.sendError(
        'This file has uncommitted changes. Please commit before enabling review mode.',
      );
      return true;
    }

    const hasUnpushed = await this.execGitLog(filePath);
    if (hasUnpushed) {
      this.sendError(
        'This file has unpushed commits. Please push before enabling review mode.',
      );
      return true;
    }

    return false;
  }

  private execGit(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: this.cwd }, (_error, stdout) => {
        resolve(stdout.trim().length > 0);
      });
    });
  }

  private execGitLog(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['log', '@{u}..HEAD', '--', filePath],
        { cwd: this.cwd },
        (error, stdout) => {
          if (error) {
            // No upstream configured — skip this check
            resolve(false);
            return;
          }
          resolve(stdout.trim().length > 0);
        },
      );
    });
  }

  private async checkGhAvailable(): Promise<boolean> {
    try {
      const available = await isGhAvailable(this.cwd);
      if (!available) {
        this.sendError(
          'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.handleGhError(err);
      return false;
    }
  }

  private async checkGhAuthenticated(): Promise<boolean> {
    try {
      const authed = await isGhAuthenticated(this.cwd);
      if (!authed) {
        this.sendError(
          'GitHub CLI is not authenticated. Run `gh auth login` in your terminal.',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.handleGhError(err);
      return false;
    }
  }

  private async checkPrExists(): Promise<PrInfo | null> {
    try {
      const prInfo = await detectPr(this.cwd);
      if (!prInfo) {
        this.sendError('No open PR found for the current branch.');
        return null;
      }
      return prInfo;
    } catch (err) {
      this.handleGhError(err);
      return null;
    }
  }

  private handleGhError(err: unknown): void {
    if (err instanceof GhApiError) {
      const category = classifyGhError(err);
      this.sendError(`GitHub API error (${category}): ${err.message}`, err.stderr);
    } else if (err instanceof Error) {
      this.sendError(err.message);
    } else {
      this.sendError('An unknown error occurred.');
    }
  }

  private sendError(message: string, details?: string): void {
    this.postMessage({
      type: 'commentError',
      message,
      details,
    } satisfies CommentErrorMessage);
  }

  private postMessage(
    message:
      | CommentDataMessage
      | ReviewSubmitResultMessage
      | CommentErrorMessage
      | LineMappingResultMessage
      | SavedPendingQueueMessage,
  ): void {
    this.webview.postMessage(message);
  }
}
