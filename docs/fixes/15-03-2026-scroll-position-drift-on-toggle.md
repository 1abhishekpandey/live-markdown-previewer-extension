Scroll Position Drift on Preview/Raw Toggle

# Problem

Toggling between Preview (WYSIWYG) and Raw mode caused consistent upward drift of ~5 lines per cycle (e.g. L51 -> L46 -> L41 -> L36 -> L31 -> L26). The position never stabilised, making round-trip toggling unusable for navigating large documents.

# Root Causes

Three independent issues combined to produce the drift:

## 1. Table text granularity mismatch

Detection (`computeAndSendAnchor`) extracted text from individual `<td>`/`<th>` cells (e.g. `"bgGlass"`), but raw markdown represents an entire row on one line (e.g. `| bgGlass | #1E1E3A | Glass-like panels |`).

After `stripMarkdownSyntax` removes pipes: `"bgGlass  #1E1E3A  Glass-like panels"`.

These never matched, so `findAnchorLine` fell back to the lossy `roughFraction * totalLines` calculation every time.

## 2. Empty anchor text on Raw -> WYSIWYG toggle

The Raw -> WYSIWYG path sent `anchorText: ''` (empty string), so DOM text matching in the webview could never work. Every toggle in this direction fell back to percentage-based scrolling.

## 3. VS Code sticky scroll header asymmetry

`revealRange(line, AtTop)` positions the target line below VS Code's sticky scroll headers (ancestor headings pinned at the top of the editor). But `visibleRanges[0].start.line` reports the actual viewport top, which includes lines behind the sticky headers.

This asymmetry meant:
- **Reading** position: `visibleRanges` reports L25 (the viewport top)
- **Writing** position: `revealRange(24, AtTop)` places L25 below sticky headers, making L20 the viewport top
- Net effect: 5 lines lost per cycle (matching the number of sticky header lines)

# Fix

## Table text extraction (`syncClient.ts`)

`extractElementText` now returns full row text for `TH`/`TD` elements by finding the parent `<tr>` and joining all cell texts with double-space:

```ts
if (el.tagName === 'TH' || el.tagName === 'TD') {
  const tr = el.closest('tr');
  if (tr) {
    const cells = tr.querySelectorAll('th, td');
    return Array.from(cells).map(c => c.textContent?.trim() ?? '').join('  ').trim();
  }
}
```

This matches `stripMarkdownSyntax` output for table rows: `| a | b | c |` -> pipes removed -> `"a  b  c"`.

`findElementByText` also de-duplicates cells in the same row (all cells return identical row text) using a `seenRows` set.

## Anchor text on Raw -> WYSIWYG (`extension.ts`)

Now sends actual stripped text from the top visible line:

```ts
const topLineText = stripMarkdownSyntax(textEditor.document.lineAt(topLine).text);
provider.setPendingPreviewAnchor(docUri, {
  anchorText: topLineText, lineIndex: topLine, totalLines, roughFraction,
});
```

## Sticky scroll compensation (`extension.ts`)

After `revealRange(targetLine, AtTop)`, a closed-loop correction measures the actual viewport position and overshoots by the delta:

```ts
editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
setTimeout(() => {
  const actual = editor.visibleRanges[0]?.start.line;
  if (actual !== undefined && actual < targetLine) {
    const adjusted = Math.min(
      targetLine + (targetLine - actual),
      Math.max(0, totalLines - 1)
    );
    editor.revealRange(
      new vscode.Range(adjusted, 0, adjusted, 0),
      vscode.TextEditorRevealType.AtTop
    );
  }
}, 30);
```

This handles any number of sticky headers dynamically.

## Additional changes

- `ScrollToAnchorMessage` in `syncProtocol.ts` now has a typed `roughFraction?: number` field (removes `(msg as any)` casts)
- `findAnchorLine` used for WYSIWYG -> Raw text matching when anchor text is available, with fraction as fallback
- DOM-based `applyScrollAnchor` tries `findElementByText` first (same coordinate system as detection), falls back to percentage scroll

# Files Changed

- `src/sync/syncProtocol.ts` - added `roughFraction` to `ScrollToAnchorMessage`
- `src/extension.ts` - text matching for both toggle directions, sticky scroll compensation
- `src/webview/syncClient.ts` - table-aware `extractElementText`, `findElementByText`, DOM-based `applyScrollAnchor`
- `src/markdownEditorProvider.ts` - no functional changes (linter adjustments only)
- `src/__tests__/unit/syncClient.handleMessage.test.ts` - updated message shapes with `roughFraction`

# Why This Fixes the Drift

- **Table text**: full row text matches deterministically in both directions (DOM <-> raw markdown)
- **Anchor text**: both toggle directions now send meaningful text for matching
- **Sticky scroll**: closed-loop compensation eliminates the `revealRange` vs `visibleRanges` asymmetry
- **Same coordinate system**: `applyScrollAnchor` uses `getBoundingClientRect().top + scrollY` on matched DOM elements, identical to how `computeAndSendAnchor` detects the first visible element

# Verification

- `npm test` - 85/85 tests pass
- `npm run check-types` - no type errors
- Manual: scroll to any position (including tables), toggle Preview -> Raw -> Preview 5+ times - position stays stable
