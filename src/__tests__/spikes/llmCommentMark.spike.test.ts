// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Mark, mergeAttributes } from '@tiptap/core';

const LlmCommentMark = Mark.create({
  name: 'llmCommentMark',
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: el => el.getAttribute('data-comment-id'),
        renderHTML: attrs => ({ 'data-comment-id': attrs.commentId }),
      },
    };
  },
  // Allow multiple marks of this type on the same range (distinct attrs = distinct instances)
  excludes: '',
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'llm-comment' }, HTMLAttributes), 0];
  },
});

describe('LlmCommentMark stacking', () => {
  test('two overlapping marks with distinct IDs both persist', () => {
    const editor = new Editor({
      extensions: [StarterKit, LlmCommentMark],
      content: '<p>The quick brown fox jumps over the lazy dog</p>',
    });

    // Mark A: positions 5-15 ("quick brown")
    editor.chain().focus().setTextSelection({ from: 5, to: 16 })
      .setMark('llmCommentMark', { commentId: 'A' }).run();

    // Mark B: positions 11-20 ("brown fox") — overlaps with A at "brown"
    editor.chain().focus().setTextSelection({ from: 11, to: 20 })
      .setMark('llmCommentMark', { commentId: 'B' }).run();

    const html = editor.getHTML();
    console.log('HTML after overlapping marks:', html);

    // Inspect the ProseMirror doc directly
    const marksAtOverlap: string[] = [];
    editor.state.doc.nodesBetween(11, 16, node => {
      for (const mark of node.marks) {
        if (mark.type.name === 'llmCommentMark') {
          marksAtOverlap.push(mark.attrs.commentId);
        }
      }
      return true;
    });

    console.log('Mark IDs at overlap region:', marksAtOverlap);

    // Expect both A and B to be present in the overlap region
    expect(marksAtOverlap).toContain('A');
    expect(marksAtOverlap).toContain('B');

    // Expect distinct spans in the rendered HTML
    const spanMatches = html.match(/data-comment-id="[AB]"/g);
    expect(spanMatches?.length).toBeGreaterThanOrEqual(2);

    editor.destroy();
  });
});
