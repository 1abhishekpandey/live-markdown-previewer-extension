// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { LlmCommentMark } from '../../webview/llmCommentMark';

const editors: Editor[] = [];

function makeEditor(content = '<p>hello world</p>'): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Markdown.configure({ html: true }), LlmCommentMark],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) {
    const editor = editors.pop();
    try {
      editor?.destroy();
    } catch {
      // ignore
    }
  }
  document.body.innerHTML = '';
});

function collectMarkIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'llmComment') {
        const id = (mark.attrs as { commentId?: string }).commentId;
        if (id != null) ids.push(id);
      }
    }
  });
  return ids;
}

describe('LlmCommentMark', () => {
  it('M1: schema flags expose excludes="" and inclusive=false', () => {
    const editor = makeEditor();
    const markType = editor.schema.marks.llmComment;
    expect(markType).toBeTruthy();
    expect(markType.spec.excludes).toBe('');
    expect(markType.spec.inclusive).toBe(false);
  });

  it('M2: setLlmComment wraps the selection in a span with data-llm-comment-id', () => {
    const editor = makeEditor('<p>hello world</p>');
    // Doc structure: <doc><paragraph>hello world</paragraph></doc>
    // Position 1 = start of "h", position 12 = end of "d" (1 + 11 chars).
    // "world" is positions 7..12 inclusive of the "w".
    const text = 'hello world';
    const wordStart = text.indexOf('world'); // 6
    const from = 1 + wordStart; // 7
    const to = from + 'world'.length; // 12

    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .setLlmComment({ commentId: 'A' })
      .run();

    const html = editor.getHTML();
    // Order of attributes can vary; assert via regex.
    const matchClassFirst = /<span class="llm-comment-mark"[^>]*data-llm-comment-id="A"[^>]*>world<\/span>/;
    const matchIdFirst = /<span [^>]*data-llm-comment-id="A"[^>]*class="llm-comment-mark"[^>]*>world<\/span>/;
    expect(matchClassFirst.test(html) || matchIdFirst.test(html)).toBe(true);
  });

  it('M3: collapsed selection is a no-op visually (no wrapping span rendered)', () => {
    const editor = makeEditor('<p>hello world</p>');
    editor.chain().focus().setTextSelection({ from: 3, to: 3 }).setLlmComment({ commentId: 'X' }).run();
    const html = editor.getHTML();
    expect(html).not.toContain('data-llm-comment-id');
  });

  it('M4: overlapping marks stack — both ids present in the overlap region', () => {
    const editor = makeEditor('<p>The quick brown fox jumps</p>');
    // "The quick brown fox jumps" → length 25
    // positions: 1='T', 5='q', 11='b', 16=' ' between brown and fox, 20='j'
    // "quick brown" → from 5 to 16
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 5, to: 16 })
      .setLlmComment({ commentId: 'A' })
      .run();

    // "brown fox" → from 11 to 20
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 11, to: 20 })
      .setLlmComment({ commentId: 'B' })
      .run();

    // Walk doc and collect marks at the overlap region (the word "brown" → 11..16)
    const idsAtOverlap = new Set<string>();
    editor.state.doc.nodesBetween(11, 16, (node) => {
      if (!node.isText) return true;
      for (const mark of node.marks) {
        if (mark.type.name === 'llmComment') {
          const id = (mark.attrs as { commentId?: string }).commentId;
          if (id != null) idsAtOverlap.add(id);
        }
      }
      return true;
    });

    expect(idsAtOverlap.has('A')).toBe(true);
    expect(idsAtOverlap.has('B')).toBe(true);

    // Rendered HTML should have at least two spans with data-llm-comment-id
    const html = editor.getHTML();
    const matches = html.match(/data-llm-comment-id="[AB]"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('M5: unsetLlmCommentById removes only the targeted id', () => {
    const editor = makeEditor('<p>The quick brown fox jumps</p>');
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 5, to: 16 })
      .setLlmComment({ commentId: 'A' })
      .run();
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 11, to: 20 })
      .setLlmComment({ commentId: 'B' })
      .run();

    const before = new Set(collectMarkIds(editor));
    expect(before.has('A')).toBe(true);
    expect(before.has('B')).toBe(true);

    editor.commands.unsetLlmCommentById('A');

    const after = new Set(collectMarkIds(editor));
    expect(after.has('A')).toBe(false);
    expect(after.has('B')).toBe(true);
  });

  it('M6: parseHTML round-trips an HTML-seeded mark with the correct commentId', () => {
    const editor = makeEditor('<p>hello <span data-llm-comment-id="X">world</span></p>');

    let foundOnWorld = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      if (node.text !== 'world') return;
      for (const mark of node.marks) {
        if (
          mark.type.name === 'llmComment' &&
          (mark.attrs as { commentId?: string }).commentId === 'X'
        ) {
          foundOnWorld = true;
        }
      }
    });

    expect(foundOnWorld).toBe(true);
  });

  it('M7: markdown serialization is identical with or without llmComment marks', () => {
    const plain = makeEditor('<p>hello world</p>');
    const plainMd = (plain.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

    const marked = makeEditor('<p>hello world</p>');
    marked
      .chain()
      .focus()
      .setTextSelection({ from: 7, to: 12 })
      .setLlmComment({ commentId: 'A' })
      .run();

    // Sanity check: the editor really did wrap the selection
    expect(marked.getHTML()).toContain('data-llm-comment-id="A"');

    const markedMd = (marked.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();

    expect(markedMd).toBe(plainMd);
    expect(markedMd).not.toContain('data-llm-comment-id');
  });

  it('clearAllLlmComments removes every llmComment mark', () => {
    const editor = makeEditor('<p>The quick brown fox jumps</p>');
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 5, to: 16 })
      .setLlmComment({ commentId: 'A' })
      .run();
    editor
      .chain()
      .focus()
      .setTextSelection({ from: 11, to: 20 })
      .setLlmComment({ commentId: 'B' })
      .run();

    expect(collectMarkIds(editor).length).toBeGreaterThan(0);

    editor.commands.clearAllLlmComments();

    expect(collectMarkIds(editor).length).toBe(0);
  });
});
