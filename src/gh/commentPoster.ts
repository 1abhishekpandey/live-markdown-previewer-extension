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
 */
async function addCommentToExistingReview(
  reviewNodeId: string,
  filePath: string,
  comment: PendingComment,
  cwd: string,
): Promise<void> {
  const startLineField = comment.diffStartLine != null
    ? `startLine: ${comment.diffStartLine}, startSide: RIGHT,`
    : '';

  const query = `mutation {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: "${reviewNodeId}",
      path: "${filePath}",
      line: ${comment.diffLine},
      side: RIGHT,
      ${startLineField}
      body: ${JSON.stringify(comment.body)}
    }) {
      thread { id }
    }
  }`;

  await execGh(['api', 'graphql', '-f', `query=${query}`], cwd);
}

/**
 * Reply to a thread via GraphQL addPullRequestReviewThreadReply.
 * Used when REST replies fail due to the "one pending review" constraint.
 * Looks up the GraphQL thread ID by finding the thread whose root comment
 * matches the reply's threadId (database ID).
 */
async function replyViaGraphQL(
  pr: PrInfo,
  reply: PendingComment,
  cwd: string,
): Promise<void> {
  // Find the GraphQL thread ID for the comment we're replying to
  const { stdout } = await execGh(
    ['api', 'graphql', '-f', `query=query {
      repository(owner: "${pr.owner}", name: "${pr.repo}") {
        pullRequest(number: ${pr.number}) {
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
    }`],
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

  await execGh(
    ['api', 'graphql', '-f', `query=mutation {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: "${matchingThread.id}",
        body: ${JSON.stringify(reply.body)}
      }) {
        comment { id }
      }
    }`],
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
        // Add comments to the existing pending review via GraphQL
        for (const comment of newComments) {
          await addCommentToExistingReview(existingReviewNodeId, filePath, comment, cwd);
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
