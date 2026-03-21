import type { PrInfo, PendingComment, BatchSubmitResult } from '../sync/commentTypes';
import { execGh } from './ghCli';

function truncateBody(body: string, maxLen = 50): string {
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen) + '...';
}

function formatCommentLine(filePath: string, comment: PendingComment): string {
  const lineRange =
    comment.diffStartLine != null
      ? `${filePath}:${comment.diffStartLine}-${comment.diffLine}`
      : `${filePath}:${comment.diffLine}`;
  return `  [new] ${lineRange} — "${truncateBody(comment.body)}"`;
}

function formatReplyLine(comment: PendingComment): string {
  return `  [reply] thread #${comment.threadId} — "${truncateBody(comment.body)}"`;
}

export async function submitReviewBatch(
  pr: PrInfo,
  newComments: PendingComment[],
  replies: PendingComment[],
  _commitSha: string,
  filePath: string,
  _cwd: string,
): Promise<BatchSubmitResult> {
  const totalCount = newComments.length + replies.length;
  const lines: string[] = [
    `[LiveMarkdown] Submit Review (${totalCount} comments to PR #${pr.number})`,
  ];

  for (const comment of newComments) {
    lines.push(formatCommentLine(filePath, comment));
  }

  for (const reply of replies) {
    lines.push(formatReplyLine(reply));
  }

  console.log(lines.join('\n'));

  return { success: true };
}

export async function getLatestCommitSha(pr: PrInfo, cwd: string): Promise<string> {
  const { stdout } = await execGh(
    ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, '--jq', '.head.sha'],
    cwd,
  );
  return stdout.trim();
}
