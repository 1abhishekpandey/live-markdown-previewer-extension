// Extension → Webview messages

export interface InitMessage {
  type: 'init';
  markdown: string;
  isReadOnly?: boolean;
}

export interface ExternalUpdateMessage {
  type: 'externalUpdate';
  markdown: string;
  version: number;
}

export type ExtensionToWebviewMessage = InitMessage | ExternalUpdateMessage;

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

export type WebviewToExtensionMessage =
  | ReadyMessage
  | EditMessage
  | UndoMessage
  | RedoMessage
  | SaveMessage;
