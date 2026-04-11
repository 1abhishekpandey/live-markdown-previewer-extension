import type { CommentThread, PendingComment } from './commentTypes';

// Extension → Webview messages

export interface InitMessage {
  type: 'init';
  markdown: string;
  isReadOnly?: boolean;
  documentDirUri?: string;
}

export interface ExternalUpdateMessage {
  type: 'externalUpdate';
  markdown: string;
  version: number;
  documentDirUri?: string;
}

export interface ScrollToAnchorMessage {
  type: 'scrollToAnchor';
  anchorText: string;
  lineIndex: number;
  totalLines: number;
  roughFraction?: number;
}

export interface CommentDataMessage {
  type: 'commentData';
  threads: CommentThread[];
  prNumber: number;
  prUrl: string;
  currentUser: string;
  diffHighlightLines: number[];
  lastFetchedAt: number;
}

export interface ReviewSubmitResultMessage {
  type: 'reviewSubmitResult';
  success: boolean;
  error?: string;
  failedReplyIds?: string[];
}

export interface CommentErrorMessage {
  type: 'commentError';
  message: string;
  details?: string;
}

export interface LineMappingResultMessage {
  type: 'lineMappingResult';
  tempId: string;
  diffLine: number | null;
  diffStartLine: number | null;
  error?: string;
}

export interface SavedPendingQueueMessage {
  type: 'savedPendingQueue';
  pending: PendingComment[];
}

export type ExtensionToWebviewMessage =
  | InitMessage
  | ExternalUpdateMessage
  | ScrollToAnchorMessage
  | CommentDataMessage
  | ReviewSubmitResultMessage
  | CommentErrorMessage
  | LineMappingResultMessage
  | SavedPendingQueueMessage;

// Webview → Extension messages

export interface ReadyMessage {
  type: 'ready';
}

export interface EditMessage {
  type: 'edit';
  markdown: string;
  version: number;
}

export interface SaveMessage {
  type: 'save';
  markdown: string;
}

export interface BaselineMessage {
  type: 'baseline';
  markdown: string;
}

export interface ScrollAnchorUpdateMessage {
  type: 'scrollAnchorUpdate';
  anchorText: string;
  roughFraction: number;
}

export interface OpenFileMessage {
  type: 'openFile';
  src: string;
}

export interface CommentToggleMessage {
  type: 'commentToggle';
  enabled: boolean;
}

export interface CommentRefreshMessage {
  type: 'commentRefresh';
}

export interface CommentOpenPrMessage {
  type: 'commentOpenPr';
}

export interface ValidateLineMessage {
  type: 'validateLine';
  tempId: string;
  workingCopyLine: number;
  workingCopyStartLine: number | null;
}

export interface SubmitReviewMessage {
  type: 'submitReview';
  pending: PendingComment[];
}

export interface SavePendingQueueMessage {
  type: 'savePendingQueue';
  pending: PendingComment[];
}

export type WebviewToExtensionMessage =
  | ReadyMessage
  | EditMessage
  | SaveMessage
  | BaselineMessage
  | ScrollAnchorUpdateMessage
  | OpenFileMessage
  | CommentToggleMessage
  | CommentRefreshMessage
  | CommentOpenPrMessage
  | ValidateLineMessage
  | SubmitReviewMessage
  | SavePendingQueueMessage;
