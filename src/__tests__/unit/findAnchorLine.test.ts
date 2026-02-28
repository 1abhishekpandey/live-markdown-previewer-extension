vi.mock('vscode', () => ({
    Range: vi.fn(),
    Position: vi.fn(),
}));

import { findAnchorLine } from '../../extension';
import type * as vscode from 'vscode';

function makeDoc(lines: string[]) {
    const text = lines.join('\n');
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
        getText: () => text,
        positionAt: (offset: number) => {
            if (lines.length === 0) return { line: 0 };
            let remaining = offset;
            for (let i = 0; i < lines.length; i++) {
                if (remaining <= lines[i].length) return { line: i };
                remaining -= lines[i].length + 1; // +1 for '\n'
            }
            return { line: lines.length - 1 };
        },
    } as unknown as vscode.TextDocument;
}

describe('findAnchorLine', () => {
    it('returns the line index for a single exact match', () => {
        const doc = makeDoc(['', '', '', '', '', '### Plugin Engine', 'other']);
        expect(findAnchorLine(doc, 'Plugin Engine', 0.5)).toBe(5);
    });

    it('picks the candidate closest to roughFraction=0 when multiple exact matches exist', () => {
        const doc = makeDoc(['## Title', 'other', '## Title', 'more']);
        expect(findAnchorLine(doc, 'Title', 0)).toBe(0);
    });

    it('picks the candidate closest to roughFraction=1 when multiple exact matches exist', () => {
        const doc = makeDoc(['## Title', 'other', '## Title', 'more']);
        expect(findAnchorLine(doc, 'Title', 1)).toBe(2);
    });

    it('falls back to prefix matching when anchorText length > 20 and no exact match exists', () => {
        // anchorText is 25 chars; prefix used for matching is first 30 chars (the whole string here)
        const anchorText = 'This is a long anchor tex'; // exactly 25 chars
        const lines = [
            'Unrelated line',
            `This is a long anchor text with extra suffix content here`,
            'Another unrelated line',
        ];
        const doc = makeDoc(lines);
        // Line 1 stripped starts with the 30-char prefix of anchorText (anchorText is only 25 chars,
        // so prefix = anchorText itself); line 1 stripped starts with that prefix → match
        expect(findAnchorLine(doc, anchorText, 0.5)).toBe(1);
    });

    it('falls back to roughFraction position when no text or prefix match exists', () => {
        // 4 lines of 4 chars each, separated by '\n': total text = 4*4 + 3 = 19 chars… use simple case
        // lines: ["aaaa", "bbbb", "cccc", "dddd"] → text = "aaaa\nbbbb\ncccc\ndddd" (19 chars)
        // roughFraction=0.5 → charOffset = Math.floor(0.5 * 19) = 9
        // positionAt(9): line 0 has 4 chars (0-4), subtract 5 → remaining=4, line 1 has 4 chars (0-4) → line 1
        const doc = makeDoc(['aaaa', 'bbbb', 'cccc', 'dddd']);
        expect(findAnchorLine(doc, 'no match here', 0.5)).toBe(1);
    });

    it('handles an empty document without throwing', () => {
        // lineCount=0, getText()="" → totalChars=0 → charOffset=Math.min(0, Math.max(0,-1))=0
        // positionAt(0) on empty doc returns { line: 0 }
        const doc = makeDoc([]);
        expect(findAnchorLine(doc, 'anything', 0.5)).toBe(0);
    });
});
