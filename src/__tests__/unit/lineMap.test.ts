// @vitest-environment happy-dom

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { buildLineMap, findPosForLine, findLineForPos, type LineMap } from '../../webview/lineMap';

let editor: Editor;

function setup(markdown: string): LineMap {
  editor.commands.setContent(markdown);
  const doc = editor.state.doc;
  const md = (editor.storage as any).markdown.parser.md;
  return buildLineMap(doc, markdown, md);
}

beforeAll(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);

  editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ history: false }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  });
});

afterAll(() => {
  editor.destroy();
});

/**
 * Helper: given a line map, assert that a specific 0-indexed markdown line
 * resolves to a ProseMirror node of the expected type.
 */
function expectLineNode(map: LineMap, line: number, expectedType: string): void {
  const pos = findPosForLine(map, line);
  expect(pos).not.toBeNull();
  const node = editor.state.doc.nodeAt(pos!);
  expect(node).not.toBeNull();
  expect(node!.type.name).toBe(expectedType);
}

/**
 * Helper: assert a line is covered by the map (has a position).
 */
function expectLineMapped(map: LineMap, line: number): void {
  expect(findPosForLine(map, line)).not.toBeNull();
}

describe('buildLineMap', () => {
  describe('simple blocks', () => {
    it('maps consecutive paragraphs', () => {
      const map = setup('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
      // Lines: 0=First, 1=blank, 2=Second, 3=blank, 4=Third
      expectLineNode(map, 0, 'paragraph');
      expectLineNode(map, 2, 'paragraph');
      expectLineNode(map, 4, 'paragraph');

      // Different positions for each paragraph
      const pos0 = findPosForLine(map, 0);
      const pos2 = findPosForLine(map, 2);
      const pos4 = findPosForLine(map, 4);
      expect(pos0).not.toBe(pos2);
      expect(pos2).not.toBe(pos4);
    });

    it('maps headings', () => {
      const map = setup('# Heading 1\n\n## Heading 2\n\n### Heading 3');
      expectLineNode(map, 0, 'heading');
      expectLineNode(map, 2, 'heading');
      expectLineNode(map, 4, 'heading');
    });

    it('maps mixed paragraphs and headings', () => {
      const map = setup('# Title\n\nSome text.\n\n## Subtitle\n\nMore text.');
      expectLineNode(map, 0, 'heading');
      expectLineNode(map, 2, 'paragraph');
      expectLineNode(map, 4, 'heading');
      expectLineNode(map, 6, 'paragraph');
    });

    it('maps horizontal rules', () => {
      const map = setup('Before.\n\n---\n\nAfter.');
      expectLineNode(map, 0, 'paragraph');
      expectLineNode(map, 2, 'horizontalRule');
      expectLineNode(map, 4, 'paragraph');
    });
  });

  describe('code blocks', () => {
    it('maps a fenced code block to its full line range', () => {
      const md = 'Before.\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter.';
      const map = setup(md);
      // Lines: 0=Before, 1=blank, 2=```js, 3=const x, 4=const y, 5=```, 6=blank, 7=After
      expectLineNode(map, 0, 'paragraph');
      expectLineNode(map, 7, 'paragraph');

      // Code block should cover lines 2-5
      const codePos = findPosForLine(map, 2);
      expect(codePos).not.toBeNull();
      const codeNode = editor.state.doc.nodeAt(codePos!);
      expect(codeNode!.type.name).toBe('codeBlock');

      // Lines 3 and 4 (inside code block) should map to the same node
      expect(findPosForLine(map, 3)).toBe(codePos);
      expect(findPosForLine(map, 4)).toBe(codePos);
    });

    it('maps multiple code blocks', () => {
      const md = '```\nfirst\n```\n\n```\nsecond\n```';
      const map = setup(md);
      const pos0 = findPosForLine(map, 0);
      const pos4 = findPosForLine(map, 4);
      expect(pos0).not.toBeNull();
      expect(pos4).not.toBeNull();
      expect(pos0).not.toBe(pos4);
    });
  });

  describe('lists', () => {
    it('maps flat bullet list items', () => {
      const md = '- item 1\n- item 2\n- item 3';
      const map = setup(md);
      // Each item is a line. The list itself spans all lines.
      expectLineMapped(map, 0);
      expectLineMapped(map, 1);
      expectLineMapped(map, 2);
    });

    it('maps flat ordered list items', () => {
      const md = '1. first\n2. second\n3. third';
      const map = setup(md);
      expectLineMapped(map, 0);
      expectLineMapped(map, 1);
      expectLineMapped(map, 2);
    });

    it('maps nested bullet lists', () => {
      const md = '- item 1\n- item 2\n  - nested a\n  - nested b\n- item 3';
      const map = setup(md);
      // Lines 0-4 should all be mapped
      for (let i = 0; i <= 4; i++) {
        expectLineMapped(map, i);
      }
    });
  });

  describe('tables', () => {
    it('maps a simple table', () => {
      const md = '| A | B |\n|---|---|\n| 1 | 2 |';
      const map = setup(md);
      // Table spans lines 0-2
      // Row-level mapping: header row at line 0, body row at line 2
      // (separator line 1 is not a token — covered by the table range)
      expectLineMapped(map, 0);
      expectLineMapped(map, 2);
    });

    it('maps a multi-row table', () => {
      const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
      const map = setup(md);
      expectLineMapped(map, 0);
      expectLineMapped(map, 2);
      expectLineMapped(map, 3);
    });
  });

  describe('blockquotes', () => {
    it('maps a simple blockquote', () => {
      const md = '> quoted text';
      const map = setup(md);
      expectLineMapped(map, 0);
    });

    it('maps a multi-line blockquote', () => {
      const md = 'Before.\n\n> line 1\n> line 2\n\nAfter.';
      const map = setup(md);
      expectLineNode(map, 0, 'paragraph');
      expectLineMapped(map, 2);
      expectLineNode(map, 5, 'paragraph');
    });
  });

  describe('task lists', () => {
    it('maps task list items', () => {
      const md = '- [x] done task\n- [ ] pending task';
      const map = setup(md);
      expectLineMapped(map, 0);
      expectLineMapped(map, 1);
    });
  });

  describe('findPosForLine / findLineForPos', () => {
    it('findPosForLine returns deepest node', () => {
      const md = '- item 1\n- item 2';
      const map = setup(md);

      // Line 0 should map to the list item (deepest), not the bullet list (container)
      const pos = findPosForLine(map, 0);
      expect(pos).not.toBeNull();

      // The position should be inside the list structure, not the list itself
      const node = editor.state.doc.nodeAt(pos!);
      expect(node).not.toBeNull();
      // Should be a leaf-level block (paragraph or listItem), not bulletList
      expect(node!.type.name).not.toBe('bulletList');
    });

    it('findLineForPos returns start line of the range', () => {
      const md = '```\nline 1\nline 2\n```';
      const map = setup(md);
      const pos = findPosForLine(map, 0);
      expect(pos).not.toBeNull();
      expect(findLineForPos(map, pos!)).toBe(0);
    });

    it('returns null for unmapped line', () => {
      const map = setup('Hello');
      expect(findPosForLine(map, 99)).toBeNull();
    });

    it('returns null for unmapped position', () => {
      const map = setup('Hello');
      expect(findLineForPos(map, 9999)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles single-line document', () => {
      const map = setup('Just one line.');
      expectLineNode(map, 0, 'paragraph');
    });

    it('handles blank lines between blocks', () => {
      const md = 'First.\n\n\n\nSecond.';
      const map = setup(md);
      expectLineNode(map, 0, 'paragraph');
      // markdown-it may collapse blank lines; just verify both paragraphs are mapped
      const positions = new Set<number>();
      for (const [, pos] of map.lineToPos) {
        positions.add(pos);
      }
      expect(positions.size).toBeGreaterThanOrEqual(2);
    });

    it('handles mixed complex content', () => {
      const md = [
        '# Title',
        '',
        'A paragraph.',
        '',
        '- list item 1',
        '- list item 2',
        '',
        '```',
        'code',
        '```',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '> quote',
        '',
        '---',
        '',
        'End.',
      ].join('\n');

      const map = setup(md);

      // Verify key lines are mapped
      expectLineNode(map, 0, 'heading');       // # Title
      expectLineNode(map, 2, 'paragraph');      // A paragraph.
      expectLineMapped(map, 4);                 // - list item 1
      expectLineMapped(map, 5);                 // - list item 2
      expectLineMapped(map, 7);                 // ``` (code block)
      expectLineMapped(map, 11);                // | A | B | (table)
      expectLineMapped(map, 15);                // > quote
      expectLineNode(map, 17, 'horizontalRule');// ---
      expectLineNode(map, 19, 'paragraph');     // End.
    });
  });
});
