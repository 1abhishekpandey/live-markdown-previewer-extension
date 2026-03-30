// @vitest-environment happy-dom

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEditor } from '../../webview/editor';
import type { Editor } from '@tiptap/core';

describe('Markdown round-trip fidelity', () => {
  let editor: Editor;
  let container: HTMLElement;

  beforeAll(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = createEditor(container);
  });

  afterAll(() => {
    editor.destroy();
    container.remove();
  });

  function roundTrip(markdown: string): string {
    editor.commands.setContent(markdown);
    return editor.storage.markdown.getMarkdown();
  }

  it('preserves simple bold and italic', () => {
    const input = 'Some **bold** and *italic* text';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves inline links', () => {
    const input = '[Link text](https://example.com)';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves image syntax as ![alt](src)', () => {
    const input = '![Alt text](https://example.com/image.png)';
    const output = roundTrip(input);
    // Should produce markdown image syntax, not <img> HTML
    expect(output).not.toContain('<img');
    expect(output).toContain('![');
  });

  it('preserves image-in-link badge syntax', () => {
    const input = '[![Badge](https://img.shields.io/badge.svg)](https://example.com)';
    const output = roundTrip(input);
    // Image inside link should survive round-trip
    expect(output).toContain('![');
    expect(output).toContain('](https://example.com)');
  });

  it('preserves headings', () => {
    const input = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves code blocks with language', () => {
    const input = '```javascript\nconst x = 1;\n```';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves code blocks with trailing newlines', () => {
    const input = '```\nline1\nline2\n\n```';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves bullet lists with dash marker', () => {
    const input = '- Item 1\n- Item 2\n- Item 3';
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves horizontal rules', () => {
    const input = 'Before\n\n---\n\nAfter';
    expect(roundTrip(input)).toBe(input);
  });

  // Document known limitations
  describe('known limitations (lossy round-trips)', () => {
    it('task list items gain blank lines between them (tightLists: false)', () => {
      // tightLists: false in Markdown.configure causes each list item to be
      // serialised as a loose list (blank line between items)
      const input = '- [ ] Unchecked\n- [x] Checked';
      const output = roundTrip(input);
      expect(output).toContain('- [ ] Unchecked');
      expect(output).toContain('- [x] Checked');
      // The serialiser inserts a blank line between items
      expect(output).toBe('- [ ] Unchecked\n\n- [x] Checked');
    });

    it('HTML blocks lose attributes', () => {
      const input = '<p align="center">Centered text</p>';
      const output = roundTrip(input);
      // HTML attributes like align are lost — document this
      expect(output).not.toContain('align="center"');
    });

    it('reference-style link definitions are consumed', () => {
      const input = '[Example][ref]\n\n[ref]: https://example.com';
      const output = roundTrip(input);
      // Reference definitions are resolved to inline links
      expect(output).not.toContain('[ref]:');
      expect(output).toContain('https://example.com');
    });

    it('HTML comments are removed', () => {
      const input = '<!-- This is a comment -->\n\nSome text';
      const output = roundTrip(input);
      expect(output).not.toContain('<!--');
    });
  });
});
