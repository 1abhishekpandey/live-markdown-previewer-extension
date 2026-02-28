Scroll Position Drift on Repeated Raw/Preview Toggle

# Problem

After the initial scroll-sync implementation landed (see `scroll-position-sync.md`), scroll
position now approximately syncs between raw and preview modes. However, **repeated toggling
causes the position to drift downward**. Each Raw→Preview→Raw cycle shifts the viewport to
show earlier content, making the target element (e.g. a heading) appear progressively lower
in the viewport until it scrolls off-screen.

Example observed with "### 3. Plugin Engine" at line 112 in a 433-line file:

| Toggle # | Mode    | "Plugin Engine" position |
|----------|---------|--------------------------|
| 0        | Raw     | Near top of viewport     |
| 1        | Preview | Moved slightly lower     |
| 2        | Raw     | Moved further lower      |
| 3        | Preview | Nearly off-screen        |

---

# Root Causes Identified

## 1. Coordinate system mismatch (pixel vs character vs ProseMirror positions)

Three different position spaces are involved:

| Context        | Unit                    | Example for line 112                |
|----------------|-------------------------|-------------------------------------|
| Raw editor     | Line number / char offset | `topLine = 111`, `charOffset = 4200` |
| Webview scroll | Pixel ratio             | `scrollY / scrollable = 0.82`       |
| ProseMirror    | Document position       | `pos = 4600` (includes node boundaries) |

No two of these map linearly to each other:

- **Lines → chars**: Variable line lengths (code blocks have long lines, empty lines have 0).
- **Chars → PM positions**: ProseMirror adds 2 positions per block node (open/close boundaries).
  Markdown syntax (`###`, ```` ``` ````, `- `) adds chars that aren't in PM text content.
- **PM positions → pixels**: Rendered headings, code blocks, tables have non-uniform heights.

Each conversion introduces a small error. A round trip through all three spaces compounds them.

## 2. `visibleRanges[0].start.line` sub-pixel drift (extension side)

After `revealRange(line, TextEditorRevealType.AtTop)`, the next read of
`visibleRanges[0].start.line` may return `line - 1` due to sub-pixel scroll offsets. This
shifts the computed char offset backward by one line on each Raw→Preview toggle.

Attempted fix: cache the fraction and the revealed line on the extension side. If
`|topLine - cachedRevealedLine| <= 2`, reuse the cached fraction instead of recomputing.

**Status**: Implemented but drift persists — suggests additional sources.

## 3. `posAtCoords` / `coordsAtPos` pixel quantisation (webview side)

In the webview, `applyScrollFraction` converts a fraction to a ProseMirror position, then
uses `coordsAtPos(pos)` to get pixel coordinates, then `scrollTo`. The reverse path
(`posAtCoords({left:0, top:0})`) reads back a slightly different PM position due to pixel
rounding. Each programmatic scroll→read cycle shifts the position.

Attempted fix: `echoFraction` — after a programmatic scroll, the webview echoes back the
exact fraction it received instead of recomputing from viewport coordinates. Cleared only
on user interaction (`wheel`/`touchmove` events, which don't fire for `scrollTo`).

**Status**: Implemented but drift persists when combined with cause #2 or other sources.

## 4. Content re-initialisation on each toggle (suspected)

When toggling Raw→Preview, the webview receives `init` (with full markdown content) followed
by `scrollToFraction`. The `init` handler calls `setContent()`, which resets ProseMirror's
DOM. This means:

- The scroll position resets to 0 after `setContent`.
- `scrollToFraction` runs on the next `requestAnimationFrame`, computing `coordsAtPos` on
  the freshly laid-out content.
- If layout is incomplete (large document), the computed coordinates may be wrong.
- The retry logic (5 × 50ms) may help but doesn't guarantee layout completion.

Additionally, the `onDidChangeViewState` handler sends an `externalUpdate` with `version: 0`
whenever the panel becomes visible. If this fires after `scrollToFraction`, it could trigger
another `setContent` and reset the scroll position.

## 5. Sticky scroll headers (suspected, not confirmed)

VS Code's "sticky scroll" feature pins ancestor scope headers (headings) at the top of the
raw editor. With sticky scroll active:

- `visibleRanges[0].start.line` may return the first line of the actual scrollable content,
  which sits below the sticky headers.
- The sticky headers occupy visual space (e.g. 3 headers × 20px = 60px) that doesn't exist
  in the preview.
- The effective "top of viewport" in raw mode is shifted down by the sticky header height,
  but the fraction calculation doesn't account for this.

This could cause a systematic offset (not drift per se, but a consistent shift that
interacts with other rounding errors to produce apparent drift).

---

# Current Implementation

## Extension side (`extension.ts`)

```
Raw → Preview:
  topLine = visibleRanges[0].start.line
  charOffset = document.offsetAt(topLine, 0)
  fraction = charOffset / document.getText().length
  → setPendingPreviewFraction(uri, fraction)

Preview → Raw:
  fraction = getLastWebviewScrollFraction(uri)   // from webview's scrollUpdate
  charOffset = fraction * totalChars
  targetLine = document.positionAt(charOffset).line
  → revealRange(targetLine, AtTop)
```

Extension-side echo: `cachedFraction` + `cachedRevealedLine` + `cachedDocUri`. If
`|topLine - cachedRevealedLine| <= 2`, reuses `cachedFraction`.

## Webview side (`syncClient.ts`)

```
scrollUpdate reporting:
  if echoFraction is set → report echoFraction
  else → posAtCoords({0,0}).pos / doc.content.size

applyScrollFraction(fraction):
  echoFraction = fraction
  targetPos = fraction * doc.content.size
  coords = coordsAtPos(targetPos)
  scrollTo(coords.top + scrollY)

Echo cleared by:
  wheel event
  touchmove event
```

## Provider side (`markdownEditorProvider.ts`)

`scrollToFraction` is sent in the `onDidReceiveMessage` handler after the `ready` message
is processed (chained via `.then()` on `handleWebviewMessage`). This ensures `init` (content)
arrives first, then the scroll position.

---

# Possible Solutions (Not Yet Tried)

## A. Text-anchor-based sync

Instead of fractions, identify the text content at the top of the viewport and search for it
in the other editor:

1. Raw→Preview: capture text of `topLine` (e.g. `"### 3. Plugin Engine"`).
2. In the webview, walk ProseMirror nodes to find the node containing this text.
3. Use `coordsAtPos` on that node's position to scroll.
4. Reverse: get text at viewport top in preview, find matching line in raw document.

**Pros**: Immune to coordinate system mismatches. Exact positioning.
**Cons**: Duplicate text content could cause false matches. Requires walking the PM tree.

## B. Line-number-based protocol with PM-to-markdown line mapping

Build an exact mapping between ProseMirror positions and markdown line numbers:

1. On `init`, walk the PM document tree and the serialised markdown in parallel.
2. Record `{pmPos, mdLine}` for each block node.
3. Use this mapping for both directions instead of fraction arithmetic.

**Pros**: Exact mapping, no rounding errors.
**Cons**: Must rebuild on content changes. Fragile if serialisation format changes.

## C. Suppress `externalUpdate` during toggle

The `onDidChangeViewState` handler sends `externalUpdate` when the panel becomes visible.
This may interfere with the `init` + `scrollToFraction` sequence by triggering a redundant
`setContent`. Suppressing it during toggle (e.g. via a flag) could prevent scroll resets.

## D. Use `scrollTo` with `behavior: 'instant'` and double-rAF

Ensure layout is complete before scrolling by waiting two `requestAnimationFrame` cycles
instead of one, and using `behavior: 'instant'` to avoid smooth-scroll animations that might
interact poorly with the retry logic.

## E. Account for sticky scroll height

Read the sticky scroll container height and subtract it from the scroll target when computing
the fraction for Raw→Preview. This would correct the systematic offset caused by sticky
headers. However, there's no public VS Code API for sticky scroll height.

---

# Files Involved

| File | Role |
|------|------|
| `src/extension.ts` | Toggle command, fraction computation, `revealRange`, extension-side echo cache |
| `src/markdownEditorProvider.ts` | `scrollStates`, `pendingPreviewFractions`, message routing, `scrollToFraction` delivery after `ready` |
| `src/webview/syncClient.ts` | `applyScrollFraction`, scroll reporting, `echoFraction` mechanism, retry logic |
| `src/sync/syncProtocol.ts` | Message type definitions (no changes needed) |
| `src/webview/styles.css` | `padding-bottom: calc(100vh - 80px)` for scroll-past-end |

---

# Debugging Checklist

1. Add `console.log` in the toggle command to print `topLine`, `charOffset`, `fraction`,
   `cachedFraction`, `cachedRevealedLine` on each toggle.

2. Add `console.log` in `applyScrollFraction` to print received `fraction`, computed
   `targetPos`, `coords.top`, `window.scrollY`, final scroll target.

3. Add `console.log` in the scroll handler to print whether `echoFraction` was used or
   computed, and the reported value.

4. Check if `externalUpdate` fires between `init` and `scrollToFraction` by logging in
   the `handleMessage` switch cases with timestamps.

5. Check if `setContent` in the `externalUpdate` handler resets `window.scrollY` to 0
   after `applyScrollFraction` has already run.

6. Test with sticky scroll disabled (`editor.stickyScroll.enabled: false`) to isolate
   whether it contributes to the offset.
