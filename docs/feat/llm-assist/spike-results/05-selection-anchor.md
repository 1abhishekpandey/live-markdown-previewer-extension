Spike 5 — Selection-anchored `+` positioning reuse

Status: REUSABLE
File: src/webview/linkDialog.ts (125 lines)

# Positioning mechanism

- Uses getSelection + getBoundingClientRect: NO — uses TipTap's `view.coordsAtPos(pos)` (lines 23–24), which returns `{left, right, top, bottom}` in viewport coordinates. This is ProseMirror-native, not `window.getSelection()`, but it is selection-anchored: it reads `view.state.selection.from` and `view.state.selection.to` (lines 22–24).
- Viewport-edge clamping: NO — no `innerWidth`/`innerHeight` guard; the overlay can overflow the right or bottom edge.
- Scroll-position compensation: NO — the overlay is `position: fixed` (line 55), so scroll offset is already irrelevant; no `scrollX`/`scrollY` adjustment needed.
- Positioning function: `positionOverlay(overlay, editor)` at lines 20–36.

# Reusability assessment

`positionOverlay` is a self-contained 16-line function with no Cmd+K-specific assumptions: it only needs a `div` and a TipTap `Editor`, and the fallback branch (lines 32–35) gracefully handles a collapsed/empty selection. For the LLM-Assist `+` button, extract or copy `positionOverlay` (or rename it `positionNearSelection`), call it on `selectionchange` / TipTap `onSelectionUpdate`, and pass the button element instead of a link-dialog overlay. The only adaptation required is adding viewport-edge clamping if the `+` button should not overflow the right edge (not currently present in `linkDialog.ts`).

# Verdict

REUSABLE — copy `positionOverlay` (lines 20–36) and call it from a `selectionchange` handler; add optional right-edge clamp if needed; no new dependency required.

# Evidence for HLD update

assumed → verified: selection-anchored positioning via `view.coordsAtPos` is already present and reusable; `@tiptap/extension-bubble-menu` is not needed.
