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
    // root.line is the file line number (side: RIGHT), not a diff position
    const workingCopyLine = root.line ?? null;
    if (workingCopyLine === null) {
      continue;
    }

    const diffLine = lineMapping.workingCopyToDiffLine.get(workingCopyLine) ?? null;
    if (diffLine === null) {
      continue;
    }

    const workingCopyStartLine = root.start_line ?? null;
    const diffStartLine = workingCopyStartLine !== null
      ? lineMapping.workingCopyToDiffLine.get(workingCopyStartLine) ?? null
      : null;

    const rootData = toCommentData(root, currentUser);
    const replyComments = (threadReplies.get(root.id) ?? [])
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => toCommentData(r, currentUser));

    const allThreadComments = [rootData, ...replyComments];

    threads.push({
      id: root.id,
      path: root.path,
      diffLine,
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
      // root.line / root.original_line are file line numbers.
      // root.position / root.original_position are diff positions.
      // Pending comments may have line: null; fall back to position.
      let workingCopyLine: number | null = null;
      let diffLine: number | null = null;

      const fileLine = root.line ?? root.original_line ?? null;
      if (fileLine !== null) {
        workingCopyLine = fileLine;
        diffLine = lineMapping.workingCopyToDiffLine.get(fileLine) ?? null;
      } else {
        const pos = root.position ?? root.original_position ?? null;
        if (pos !== null) {
          diffLine = pos;
          workingCopyLine = lineMapping.diffLineToWorkingCopy.get(pos) ?? null;
        }
      }

      if (workingCopyLine === null || diffLine === null) {
        continue;
      }

      const workingCopyStartLine = root.start_line ?? null;
      const diffStartLine = workingCopyStartLine !== null
        ? lineMapping.workingCopyToDiffLine.get(workingCopyStartLine) ?? null
        : null;

      const rootData = toCommentData(root, currentUser, true);
      const replyComments = (threadReplies.get(root.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => toCommentData(r, currentUser, true));

      const allThreadComments = [rootData, ...replyComments];

      threads.push({
        id: root.id,
        path: root.path,
        diffLine,
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
