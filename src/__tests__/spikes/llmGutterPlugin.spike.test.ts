// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

const PK = new PluginKey('llmGutter');

// Minimal plugin that decorates every block node with:
//   - class="llm-gutter-empty" (hover rule in CSS shows "+")
//   - OR class="llm-gutter-count" data-count="N" (commented lines)
const LlmGutterExtension = Extension.create({
  name: 'llmGutter',
  addProseMirrorPlugins() {
    const commentCounts = new Map<number, number>();
    commentCounts.set(1, 2); // line index 1 has 2 comments

    return [
      new Plugin({
        key: PK,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            let lineIndex = 0;
            state.doc.forEach((node, offset) => {
              if (node.isBlock) {
                const count = commentCounts.get(lineIndex);
                if (count && count > 0) {
                  decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                      class: 'llm-gutter-count',
                      'data-count': String(count),
                    }),
                  );
                } else {
                  decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                      class: 'llm-gutter-empty',
                    }),
                  );
                }
                lineIndex++;
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

describe('LlmGutterPlugin decoration slots', () => {
  test('decorates uncommented and commented lines with distinct classes', () => {
    const editor = new Editor({
      extensions: [StarterKit, LlmGutterExtension],
      content: '<p>first line</p><p>second line</p><p>third line</p>',
    });

    // Wait one microtask for decoration application
    const dom = editor.view.dom as HTMLElement;
    const empty = dom.querySelectorAll('.llm-gutter-empty');
    const counted = dom.querySelectorAll('.llm-gutter-count');

    console.log('Empty gutter lines:', empty.length);
    console.log('Counted gutter lines:', counted.length);
    counted.forEach(el => console.log('  count attr:', el.getAttribute('data-count')));

    expect(empty.length).toBe(2); // lines 0 and 2
    expect(counted.length).toBe(1); // line 1
    expect(counted[0]?.getAttribute('data-count')).toBe('2');

    editor.destroy();
  });
});
