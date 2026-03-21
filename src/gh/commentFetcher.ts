import type { PrInfo, CommentData, CommentThread, LineMapping } from '../sync/commentTypes';
import { execGh } from './ghCli';

interface GitHubReviewComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  position: number | null;
  original_position: number | null;
  in_reply_to_id?: number;
  side: string;
}

function parsePaginatedJson(stdout: string): GitHubReviewComment[] {
  if (!stdout.trim()) {
    return [];
  }

  try {
    return JSON.parse(stdout);
  } catch {
    // gh --paginate concatenates JSON arrays: `[...][...]`
    const merged = stdout
      .split(/\]\s*\[/)
      .map((chunk, i, arr) => {
        let c = chunk;
        if (i > 0) c = '[' + c;
        if (i < arr.length - 1) c = c + ']';
        return JSON.parse(c) as GitHubReviewComment[];
      })
      .flat();
    return merged;
  }
}

function toCommentData(
  comment: GitHubReviewComment,
  currentUser: string,
  isPending = false,
): CommentData {
  return {
    id: comment.id,
    author: comment.user.login,
    body: comment.body,
    createdAt: comment.created_at,
    isOwn: comment.user.login === currentUser,
    isOutdated: comment.line === null && comment.original_line !== null,
    isPending,
  };
}

interface GitHubReview {
  id: number;
  state: string;
  user: { login: string };
  node_id: string;
}

export async function fetchComments(
  pr: PrInfo,
  filePath: string,
  lineMapping: LineMapping,
  currentUser: string,
  cwd: string,
): Promise<CommentThread[]> {
  const { stdout } = await execGh(
    ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, '--paginate'],
    cwd,
  );

  const allComments = parsePaginatedJson(stdout);
  const fileComments = allComments.filter((c) => c.path === filePath);

  const roots: GitHubReviewComment[] = [];
  const replies: GitHubReviewComment[] = [];

  for (const comment of fileComments) {
    if (comment.in_reply_to_id) {
      replies.push(comment);
    } else {
      roots.push(comment);
    }
  }

  const rootById = new Map<number, GitHubReviewComment>();
  for (const root of roots) {
    rootById.set(root.id, root);
  }

  const threadReplies = new Map<number, GitHubReviewComment[]>();

  for (const reply of replies) {
    const parentId = reply.in_reply_to_id!;
    if (!rootById.has(parentId)) {
      // Orphan reply: treat as a new root
      rootById.set(reply.id, reply);
      continue;
    }
    const existing = threadReplies.get(parentId) ?? [];
    existing.push(reply);
    threadReplies.set(parentId, existing);
  }

  const threads: CommentThread[] = [];

  for (const root of rootById.values()) {
    const diffLine = root.line;
    const diffStartLine = root.start_line ?? null;

    const workingCopyLine = diffLine !== null
      ? lineMapping.diffLineToWorkingCopy.get(diffLine) ?? null
      : null;

    if (workingCopyLine === null) {
      continue;
    }

    const workingCopyStartLine = diffStartLine !== null
      ? lineMapping.diffLineToWorkingCopy.get(diffStartLine) ?? null
      : null;

    const rootData = toCommentData(root, currentUser);
    const replyComments = (threadReplies.get(root.id) ?? [])
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => toCommentData(r, currentUser));

    const allThreadComments = [rootData, ...replyComments];

    threads.push({
      id: root.id,
      path: root.path,
      diffLine: diffLine!,
      diffStartLine,
      workingCopyLine,
      workingCopyStartLine,
      comments: allThreadComments,
    });
  }

  threads.sort((a, b) => a.workingCopyLine - b.workingCopyLine);
  return threads;
}

export async function fetchPendingReviewComments(
  pr: PrInfo,
  filePath: string,
  lineMapping: LineMapping,
  currentUser: string,
  cwd: string,
): Promise<CommentThread[]> {
  try {
    const { stdout: reviewsOut } = await execGh(
      ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`],
      cwd,
    );
    const reviews: GitHubReview[] = JSON.parse(reviewsOut);
    const pendingReview = reviews.find(
      (r) => r.state === 'PENDING' && r.user.login === currentUser,
    );
    if (!pendingReview) return [];

    const { stdout: commentsOut } = await execGh(
      ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${pendingReview.id}/comments`],
      cwd,
    );
    const comments: GitHubReviewComment[] = JSON.parse(commentsOut);
    const fileComments = comments.filter((c) => c.path === filePath);

    const roots: GitHubReviewComment[] = [];
    const replies: GitHubReviewComment[] = [];

    for (const comment of fileComments) {
      if (comment.in_reply_to_id) {
        replies.push(comment);
      } else {
        roots.push(comment);
      }
    }

    const rootById = new Map<number, GitHubReviewComment>();
    for (const root of roots) {
      rootById.set(root.id, root);
    }

    const threadReplies = new Map<number, GitHubReviewComment[]>();

    for (const reply of replies) {
      const parentId = reply.in_reply_to_id!;
      if (!rootById.has(parentId)) {
        rootById.set(reply.id, reply);
        continue;
      }
      const existing = threadReplies.get(parentId) ?? [];
      existing.push(reply);
      threadReplies.set(parentId, existing);
    }

    const threads: CommentThread[] = [];

    for (const root of rootById.values()) {
      // Pending comments have line: null and original_line: null.
      // Fall back to position/original_position which is the diff position.
      const diffLine = root.line ?? root.original_line ?? root.position ?? root.original_position;
      const diffStartLine = root.start_line ?? null;

      const workingCopyLine = diffLine !== null
        ? lineMapping.diffLineToWorkingCopy.get(diffLine) ?? null
        : null;

      if (workingCopyLine === null) {
        continue;
      }

      const workingCopyStartLine = diffStartLine !== null
        ? lineMapping.diffLineToWorkingCopy.get(diffStartLine) ?? null
        : null;

      const rootData = toCommentData(root, currentUser, true);
      const replyComments = (threadReplies.get(root.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => toCommentData(r, currentUser, true));

      const allThreadComments = [rootData, ...replyComments];

      threads.push({
        id: root.id,
        path: root.path,
        diffLine: diffLine!,
        diffStartLine,
        workingCopyLine,
        workingCopyStartLine,
        comments: allThreadComments,
      });
    }

    threads.sort((a, b) => a.workingCopyLine - b.workingCopyLine);
    return threads;
  } catch {
    return [];
  }
}

export async function fetchCurrentUser(cwd: string): Promise<string> {
  const { stdout } = await execGh(['api', 'user', '--jq', '.login'], cwd);
  return stdout.trim();
}
