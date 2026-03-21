import type { PrInfo, PendingComment, BatchSubmitResult } from '../sync/commentTypes';
import { execGh, GhApiError } from './ghCli';

/**
 * Find an existing PENDING review for the current user.
 * Returns the node_id (for GraphQL) or null if none exists.
 */
async function findPendingReviewNodeId(pr: PrInfo, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGh(
      ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
       '--jq', '[.[] | select(.state == "PENDING")][0].node_id // empty'],
      cwd,
    );
    const nodeId = stdout.trim();
    return nodeId || null;
  } catch {
    return null;
  }
}

/**
 * Add a comment to an existing pending review via GraphQL
 * addPullRequestReviewThread mutation.
 *
 * Uses parameterised GraphQL variables instead of string interpolation
 * to prevent injection via filePath, reviewNodeId, or comment body.
 */
async function addCommentToExistingReview(
  reviewNodeId: string,
  filePath: string,
  comment: PendingComment,
  cwd: string,
): Promise<void> {
  const hasStartLine = comment.diffStartLine != null;

  const mutation = hasStartLine
    ? `mutation($reviewId: ID!, $path: String!, $line: Int!, $startLine: Int!, $body: String!) {
        addPullRequestReviewThread(input: {
          pullRequestReviewId: $reviewId,
          path: $path,
          line: $line,
          side: RIGHT,
          startLine: $startLine,
          startSide: RIGHT,
          body: $body
        }) { thread { id } }
      }`
    : `mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
        addPullRequestReviewThread(input: {
          pullRequestReviewId: $reviewId,
          path: $path,
          line: $line,
          side: RIGHT,
          body: $body
        }) { thread { id } }
      }`;

  const args = [
    'api', 'graphql',
    '-f', `query=${mutation}`,
    '-f', `reviewId=${reviewNodeId}`,
    '-f', `path=${filePath}`,
    '-F', `line=${comment.diffLine}`,
    '-f', `body=${comment.body}`,
  ];

  if (hasStartLine) {
    args.push('-F', `startLine=${comment.diffStartLine}`);
  }

  await execGh(args, cwd);
}

/**
 * Reply to a thread via GraphQL addPullRequestReviewThreadReply.
 * Used when REST replies fail due to the "one pending review" constraint.
 * Looks up the GraphQL thread ID by finding the thread whose root comment
 * matches the reply's threadId (database ID).
 *
 * Uses parameterised GraphQL variables to prevent injection.
 */
async function replyViaGraphQL(
  pr: PrInfo,
  reply: PendingComment,
  cwd: string,
): Promise<void> {
  const threadQuery = `query($owner: String!, $name: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $prNumber) {
        reviewThreads(last: 100) {
          nodes {
            id
            comments(first: 1) {
              nodes { databaseId }
            }
          }
        }
      }
    }
  }`;

  const { stdout } = await execGh(
    [
      'api', 'graphql',
      '-f', `query=${threadQuery}`,
      '-f', `owner=${pr.owner}`,
      '-f', `name=${pr.repo}`,
      '-F', `prNumber=${pr.number}`,
    ],
    cwd,
  );

  const data = JSON.parse(stdout);
  const threadNodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const matchingThread = threadNodes.find((t: any) =>
    t.comments?.nodes?.some((c: any) => c.databaseId === reply.threadId)
  );

  if (!matchingThread) {
    throw new Error(`Could not find thread for comment ${reply.threadId}`);
  }

  const replyMutation = `mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {
      pullRequestReviewThreadId: $threadId,
      body: $body
    }) {
      comment { id }
    }
  }`;

  await execGh(
    [
      'api', 'graphql',
      '-f', `query=${replyMutation}`,
      '-f', `threadId=${matchingThread.id}`,
      '-f', `body=${reply.body}`,
    ],
    cwd,
  );
}

export async function submitReviewBatch(
  pr: PrInfo,
  newComments: PendingComment[],
  replies: PendingComment[],
  commitSha: string,
  filePath: string,
  cwd: string,
): Promise<BatchSubmitResult> {
  const totalCount = newComments.length + replies.length;
  if (totalCount === 0) return { success: true };

  // Post new comments as a pending review (draft — no notifications)
  if (newComments.length > 0) {
    try {
      // Check if a pending review already exists
      const existingReviewNodeId = await findPendingReviewNodeId(pr, cwd);

      if (existingReviewNodeId) {
        // Add comments to the existing pending review via GraphQL.
        // Track partial success to avoid re-queuing already-posted comments.
        const postedTempIds: string[] = [];
        for (const comment of newComments) {
          try {
            await addCommentToExistingReview(existingReviewNodeId, filePath, comment, cwd);
            postedTempIds.push(comment.tempId);
          } catch (err) {
            const failedTempIds = newComments
              .filter(c => !postedTempIds.includes(c.tempId))
              .map(c => c.tempId);
            const message = err instanceof GhApiError ? err.stderr : (err instanceof Error ? err.message : 'Unknown error');
            return { success: false, error: `Failed to create review: ${message}`, failedReplyIds: failedTempIds };
          }
        }
      } else {
        // Create a new pending review via REST (omitting event = PENDING)
        const reviewBody = {
          commit_id: commitSha,
          comments: newComments.map(c => {
            const comment: Record<string, unknown> = {
              path: filePath,
              line: c.diffLine,
              side: 'RIGHT',
              body: c.body,
            };
            if (c.diffStartLine != null) {
              comment.start_line = c.diffStartLine;
              comment.start_side = 'RIGHT';
            }
            return comment;
          }),
        };

        await execGh(
          ['api', '--method', 'POST', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, '--input', '-'],
          cwd,
          JSON.stringify(reviewBody),
        );
      }
    } catch (err) {
      const message = err instanceof GhApiError ? err.stderr : (err instanceof Error ? err.message : 'Unknown error');
      return { success: false, error: `Failed to create review: ${message}` };
    }
  }

  // Post replies individually — try REST first, fall back to GraphQL
  // if a pending review exists (REST creates a new review context which conflicts)
  const failedReplyIds: string[] = [];
  for (const reply of replies) {
    try {
      const replyBody = {
        body: reply.body,
        in_reply_to: reply.threadId,
      };
      await execGh(
        ['api', '--method', 'POST', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`, '--input', '-'],
        cwd,
        JSON.stringify(replyBody),
      );
    } catch {
      // REST failed (likely "one pending review" conflict) — try GraphQL
      try {
        await replyViaGraphQL(pr, reply, cwd);
      } catch {
        failedReplyIds.push(reply.tempId);
      }
    }
  }

  if (failedReplyIds.length > 0) {
    return { success: false, failedReplyIds };
  }

  return { success: true };
}

export async function getLatestCommitSha(pr: PrInfo, cwd: string): Promise<string> {
  const { stdout } = await execGh(
    ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, '--jq', '.head.sha'],
    cwd,
  );
  return stdout.trim();
}
