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

export type ExtensionToWebviewMessage = InitMessage | ExternalUpdateMessage | ScrollToAnchorMessage;

// Webview → Extension messages

export interface ReadyMessage {
  type: 'ready';
}

export interface EditMessage {
  type: 'edit';
  markdown: string;
  version: number;
}

export interface UndoMessage {
  type: 'undo';
}

export interface RedoMessage {
  type: 'redo';
}

export interface SaveMessage {
  type: 'save';
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

export type WebviewToExtensionMessage =
  | ReadyMessage
  | EditMessage
  | UndoMessage
  | RedoMessage
  | SaveMessage
  | ScrollAnchorUpdateMessage
  | OpenFileMessage;
