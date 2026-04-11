import type { LlmToggle } from './llmToggle';
import type { LlmCommentStore } from './llmCommentStore';
import type { CommentPanel } from './commentPanel';

/**
 * Pure message-routing helper for LLM-Assist webview messages.
 *
 * Extracted from `index.ts` so it can be unit-tested without importing the
 * side-effecting entry module (which calls `acquireVsCodeApi`, creates DOM
 * elements, and registers plugins at import time).
 *
 * Returns `true` if the message was consumed by the LLM pipeline and the
 * caller should short-circuit further routing.
 */
export function dispatchLlmMessage(data: unknown, llmToggle: LlmToggle): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as { type?: unknown };
  if (msg.type === 'toggleLlmAssist') {
    llmToggle.toggle();
    return true;
  }
  return false;
}

/**
 * Pure click-routing helper for LLM-Assist editor clicks.
 *
 * Returns `true` if the click was consumed (caller should stop propagation
 * and prevent default). Short-circuits to `false` when LLM-Assist mode is
 * inactive so the standard editor click flow runs.
 */
export function dispatchLlmEditorClick(
  target: HTMLElement,
  llmToggle: LlmToggle,
  llmStore: LlmCommentStore,
  commentPanel: CommentPanel,
): boolean {
  if (!llmToggle.isActive()) return false;

  // Click on a commented text span → open the LLM-text panel
  const span = target.closest('[data-llm-comment-id]') as HTMLElement | null;
  if (span) {
    const id = span.getAttribute('data-llm-comment-id');
    if (id && llmStore.get(id)) {
      commentPanel.openLlmText(id, span);
      return true;
    }
  }

  // Click on a commented line (.llm-line-commented with data-llm-line) → open
  // the LLM-line panel.
  const commentedLine = target.closest(
    '.llm-line-commented[data-llm-line]',
  ) as HTMLElement | null;
  if (commentedLine) {
    const lineStr = commentedLine.getAttribute('data-llm-line');
    const line1 = lineStr ? Number(lineStr) : NaN;
    if (!isNaN(line1)) {
      commentPanel.openLlmLine(line1, commentedLine);
      return true;
    }
  }

  return false;
}
