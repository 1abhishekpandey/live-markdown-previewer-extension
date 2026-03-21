export interface PrInfo {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  owner: string;
  repo: string;
}

export interface CommentData {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isOwn: boolean;
  isOutdated: boolean;
  isPending: boolean;
}

export interface CommentThread {
  id: number;
  path: string;
  diffLine: number;
  diffStartLine: number | null;
  workingCopyLine: number;
  workingCopyStartLine: number | null;
  comments: CommentData[];
}

export interface PendingComment {
  tempId: string;
  threadId: number | null;
  body: string;
  workingCopyLine: number;
  workingCopyStartLine: number | null;
  diffLine: number | null;
  diffStartLine: number | null;
}

export interface DiffLineInfo {
  lineNumber: number;
  type: 'added' | 'modified';
}

export interface LineMapping {
  diffLineToWorkingCopy: Map<number, number>;
  workingCopyToDiffLine: Map<number, number>;
  addedLines: DiffLineInfo[];
}

export interface BatchSubmitResult {
  success: boolean;
  error?: string;
  failedReplyIds?: string[];
}
