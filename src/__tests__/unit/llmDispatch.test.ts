// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchLlmMessage, dispatchLlmEditorClick } from '../../webview/llmDispatch';
import { LlmCommentStore } from '../../webview/llmCommentStore';

function makeMockToggle(active = true) {
  return {
    isActive: vi.fn(() => active),
    toggle: vi.fn(),
  } as any;
}

function makeMockPanel() {
  return {
    openLlmText: vi.fn(),
    openLlmLine: vi.fn(),
  } as any;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dispatchLlmMessage', () => {
  it('T12: toggleLlmAssist message calls llmToggle.toggle() and returns true', () => {
    const toggle = makeMockToggle();
    const handled = dispatchLlmMessage({ type: 'toggleLlmAssist' }, toggle);
    expect(handled).toBe(true);
    expect(toggle.toggle).toHaveBeenCalledOnce();
  });

  it('returns false for non-LLM messages', () => {
    const toggle = makeMockToggle();
    expect(dispatchLlmMessage({ type: 'init' }, toggle)).toBe(false);
    expect(dispatchLlmMessage({ type: 'commentData' }, toggle)).toBe(false);
    expect(toggle.toggle).not.toHaveBeenCalled();
  });

  it('returns false for non-object input without throwing', () => {
    const toggle = makeMockToggle();
    expect(dispatchLlmMessage(null, toggle)).toBe(false);
    expect(dispatchLlmMessage(undefined, toggle)).toBe(false);
    expect(dispatchLlmMessage('string', toggle)).toBe(false);
    expect(toggle.toggle).not.toHaveBeenCalled();
  });
});

describe('dispatchLlmEditorClick', () => {
  it('opens openLlmText when clicking a data-llm-comment-id span whose id is in the store', () => {
    const toggle = makeMockToggle(true);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();
    store.add({ id: 'X', kind: 'text', body: 'note', createdAt: 1, startLine: 3, endLine: 3 });

    const span = document.createElement('span');
    span.setAttribute('data-llm-comment-id', 'X');
    document.body.appendChild(span);

    const handled = dispatchLlmEditorClick(span, toggle, store, panel);
    expect(handled).toBe(true);
    expect(panel.openLlmText).toHaveBeenCalledWith('X', span);
    expect(panel.openLlmLine).not.toHaveBeenCalled();
  });

  it('resolves data-llm-comment-id from an ancestor span via closest', () => {
    const toggle = makeMockToggle(true);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();
    store.add({ id: 'Y', kind: 'text', body: 'note', createdAt: 1, startLine: 2, endLine: 2 });

    const span = document.createElement('span');
    span.setAttribute('data-llm-comment-id', 'Y');
    const innerText = document.createElement('em');
    innerText.textContent = 'inner';
    span.appendChild(innerText);
    document.body.appendChild(span);

    const handled = dispatchLlmEditorClick(innerText, toggle, store, panel);
    expect(handled).toBe(true);
    expect(panel.openLlmText).toHaveBeenCalledWith('Y', span);
  });

  it('returns false when the data-llm-comment-id is missing from the store (ghost mark)', () => {
    const toggle = makeMockToggle(true);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();

    const span = document.createElement('span');
    span.setAttribute('data-llm-comment-id', 'GHOST');
    document.body.appendChild(span);

    const handled = dispatchLlmEditorClick(span, toggle, store, panel);
    expect(handled).toBe(false);
    expect(panel.openLlmText).not.toHaveBeenCalled();
    expect(panel.openLlmLine).not.toHaveBeenCalled();
  });

  it('opens openLlmLine when clicking a .llm-line-commented[data-llm-line] node', () => {
    const toggle = makeMockToggle(true);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();

    const node = document.createElement('div');
    node.className = 'llm-line-commented';
    node.setAttribute('data-llm-line', '5');
    document.body.appendChild(node);

    const handled = dispatchLlmEditorClick(node, toggle, store, panel);
    expect(handled).toBe(true);
    expect(panel.openLlmLine).toHaveBeenCalledWith(5, node);
  });

  it('short-circuits entirely when llmToggle is inactive', () => {
    const toggle = makeMockToggle(false);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();
    store.add({ id: 'X', kind: 'line', body: 'note', createdAt: 1, startLine: 1, endLine: 1 });

    const span = document.createElement('span');
    span.setAttribute('data-llm-comment-id', 'X');

    const handled = dispatchLlmEditorClick(span, toggle, store, panel);
    expect(handled).toBe(false);
    expect(panel.openLlmText).not.toHaveBeenCalled();
    expect(panel.openLlmLine).not.toHaveBeenCalled();
  });

  it('returns false when the clicked target has no matching ancestor', () => {
    const toggle = makeMockToggle(true);
    const panel = makeMockPanel();
    const store = new LlmCommentStore();

    const div = document.createElement('div');
    document.body.appendChild(div);

    const handled = dispatchLlmEditorClick(div, toggle, store, panel);
    expect(handled).toBe(false);
  });
});
