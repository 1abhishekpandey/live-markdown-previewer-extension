vi.mock('vscode', () => ({}));

import { stripMarkdownSyntax } from '../../extension';

describe('stripMarkdownSyntax', () => {
    it('strips h3 heading prefix', () => {
        expect(stripMarkdownSyntax('### Heading')).toBe('Heading');
    });

    it('strips h1 heading prefix and inline bold', () => {
        expect(stripMarkdownSyntax('# H1 with **bold**')).toBe('H1 with bold');
    });

    it('strips h2 heading prefix', () => {
        expect(stripMarkdownSyntax('## Level 2')).toBe('Level 2');
    });

    it('strips unordered list prefix (dash)', () => {
        expect(stripMarkdownSyntax('- list item')).toBe('list item');
    });

    it('strips unordered list prefix (star)', () => {
        expect(stripMarkdownSyntax('* star list')).toBe('star list');
    });

    it('strips ordered list prefix', () => {
        expect(stripMarkdownSyntax('1. numbered')).toBe('numbered');
    });

    it('strips checked task list prefix', () => {
        expect(stripMarkdownSyntax('- [x] checked')).toBe('checked');
    });

    it('strips unchecked task list prefix', () => {
        expect(stripMarkdownSyntax('- [ ] unchecked')).toBe('unchecked');
    });

    it('strips blockquote prefix', () => {
        expect(stripMarkdownSyntax('> blockquote')).toBe('blockquote');
    });

    it('strips blockquote prefix but leaves [!NOTE] alert text intact', () => {
        // Blockquote prefix stripped → "[!NOTE] alert"
        // No heading match (starts with '['), no list/checkbox match ('[!' ≠ '[ xX]')
        // Inline patterns do not match '[!NOTE]'
        expect(stripMarkdownSyntax('> [!NOTE] alert')).toBe('[!NOTE] alert');
    });

    it('strips bold inline formatting', () => {
        expect(stripMarkdownSyntax('**bold**')).toBe('bold');
    });

    it('strips italic inline formatting (asterisk)', () => {
        expect(stripMarkdownSyntax('*italic*')).toBe('italic');
    });

    it('strips italic inline formatting (underscore)', () => {
        expect(stripMarkdownSyntax('_italic_')).toBe('italic');
    });

    it('strips inline code formatting', () => {
        expect(stripMarkdownSyntax('`code`')).toBe('code');
    });

    it('strips strikethrough formatting', () => {
        expect(stripMarkdownSyntax('~~strike~~')).toBe('strike');
    });

    it('strips inline link, keeping label text', () => {
        expect(stripMarkdownSyntax('[link](url)')).toBe('link');
    });

    it('strips inline image syntax, keeping alt text', () => {
        expect(stripMarkdownSyntax('![img](url)')).toBe('img');
    });

    it('strips table pipe characters', () => {
        expect(stripMarkdownSyntax('| table |')).toBe('table');
    });

    it('returns empty string for empty input', () => {
        expect(stripMarkdownSyntax('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
        expect(stripMarkdownSyntax('   ')).toBe('');
    });
});
