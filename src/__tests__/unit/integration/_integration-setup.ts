// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createEditor } from '../../../webview/editor';
import { LlmCommentStore } from '../../../webview/llmCommentStore';
import { LlmToggle } from '../../../webview/llmToggle';
import { LlmSelectionAnchor } from '../../../webview/llmSelectionAnchor';
import { CommentPanel } from '../../../webview/commentPanel';
import { PendingCommentStore } from '../../../webview/pendingCommentStore';
import { buildLineMap, type LineMap } from '../../../webview/lineMap';
import {
  createCommentIndicatorPlugin,
  updateCommentIndicatorState,
  getCommentIndicatorState,
} from '../../../webview/commentIndicator';

export interface IntegrationHarness {
  editorElement: HTMLElement;
  editor: Editor;
  llmStore: LlmCommentStore;
  pendingStore: PendingCommentStore;
  commentPanel: CommentPanel;
  llmToggle: LlmToggle;
  llmSelectionAnchor: LlmSelectionAnchor;
  commentToggleMock: { isActive: ReturnType<typeof vi.fn> };
  clipboardSpy: ReturnType<typeof vi.fn>;
  llmLineMapRef: { current: LineMap | null };
  destroy: () => void;
}

/**
 * Build an end-to-end happy-dom harness that mirrors the Phase 6 wiring in
 * `src/webview/index.ts`. Everything is real — editor, store, mark,
 * indicator plugin, panel, toggle — except for a minimal CommentToggle stub
 * (so we can drive the mode-mutex path) and a stubbed `navigator.clipboard`.
 */
export function makeIntegrationHarness(seedHtml: string): IntegrationHarness {
  document.body.innerHTML = '';

  const editorElement = document.createElement('div');
  editorElement.id = 'editor';
  document.body.appendChild(editorElement);

  const editor = createEditor(editorElement);
  // Seed the doc. TipTap's setContent interprets strings as HTML by default,
  // so callers should pass HTML (e.g. '<p>hello</p>').
  editor.commands.setContent(seedHtml);

  const vscode = { postMessage: vi.fn() };
  const pendingStore = new PendingCommentStore(vscode);
  const llmStore = new LlmCommentStore();
  const commentPanel = new CommentPanel(editorElement, pendingStore, vscode, llmStore, editor);

  const llmLineMapRef: { current: LineMap | null } = { current: null };
  const rebuildLineMap = (): void => {
    const latestMd = (editor.storage as any).markdown?.parser?.md;
    const latest = editor.storage.markdown.getMarkdown();
    llmLineMapRef.current = latestMd
      ? buildLineMap(editor.state.doc, latest, latestMd)
      : null;
  };

  const llmSelectionAnchor = new LlmSelectionAnchor(
    editor,
    llmStore,
    commentPanel,
    editorElement,
    () => llmLineMapRef.current,
  );

  const commentToggleMock = { isActive: vi.fn(() => false) };

  // Register the indicator plugin so any decoration-based assertions work.
  editor.registerPlugin(createCommentIndicatorPlugin());

  const llmToggle = new LlmToggle(
    editor,
    vscode,
    llmStore,
    commentPanel,
    commentToggleMock as any,
    llmSelectionAnchor,
    (patch) => {
      const current = getCommentIndicatorState(editor.view);
      updateCommentIndicatorState(editor.view, {
        ...current,
        llmAssistActive: patch.llmAssistActive ?? current.llmAssistActive ?? false,
        llmComments: (patch.llmComments as any) ?? current.llmComments ?? [],
        lineMap: llmLineMapRef.current ?? current.lineMap,
      });
    },
    rebuildLineMap,
  );

  // Match the Phase 6 wiring so store changes republish plugin state while
  // the toggle is active. This isn't load-bearing for most integration
  // assertions, but keeps behaviour parity with production.
  llmStore.onChange(() => {
    if (!llmToggle.isActive()) return;
    const current = getCommentIndicatorState(editor.view);
    updateCommentIndicatorState(editor.view, {
      ...current,
      llmComments: llmStore.getAll(),
    });
  });

  // Stub clipboard via defineProperty — happy-dom defines it as a getter.
  const clipboardSpy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardSpy },
  });

  return {
    editorElement,
    editor,
    llmStore,
    pendingStore,
    commentPanel,
    llmToggle,
    llmSelectionAnchor,
    commentToggleMock,
    clipboardSpy,
    llmLineMapRef,
    destroy: () => {
      llmToggle.dispose();
      llmSelectionAnchor.destroy?.();
      commentPanel.dispose?.();
      editor.destroy();
      document.body.innerHTML = '';
    },
  };
}
