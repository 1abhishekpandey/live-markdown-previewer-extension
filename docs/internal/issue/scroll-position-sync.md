Scroll Position Sync on Raw/Preview Toggle — Investigation & Status

# Background

The extension provides a toggle command (`liveMarkdown.toggleRawMarkdown`, default `Cmd+Shift+M`)
that switches a `.md` file between the built-in text editor (raw mode) and the custom TipTap
webview (preview mode). The toggle is implemented via
`workbench.action.toggleEditorType`.

The expected behaviour is that toggling preserves the user's relative scroll position in both
directions:

- **Raw → Preview**: the preview should scroll to the same relative region the user was
  viewing in the raw editor.
- **Preview → Raw**: the raw editor should open at the same relative line the preview was
  scrolled to.

A *scroll fraction* (`topLine / lineCount` for raw, `scrollY / (scrollHeight - innerHeight)`
for preview) is used as the interchange unit, since the two editors measure position in
different units.

---

# Architecture

Two runtime contexts communicate via `postMessage`:

```
Extension (Node)                 Webview (Browser)
────────────────                 ─────────────────
MarkdownEditorProvider           SyncClient
  scrollStates: Map              isInitialized: bool
  pendingPreviewFractions: Map   pendingScrollFraction: number|null
  pendingRawFraction: number
```

**New message types added in `syncProtocol.ts`:**

| Direction            | Type               | Payload            |
|----------------------|--------------------|--------------------|
| Extension → Webview  | `scrollToFraction` | `fraction: number` |
| Webview → Extension  | `scrollUpdate`     | `fraction: number` |

The webview continuously reports its scroll position via debounced `scrollUpdate` messages
(150 ms debounce). The extension stores the latest fraction in `scrollStates` per document.

---

# Preview → Raw (status: implemented, appears to work)

1. Toggle command fires. `vscode.window.activeTextEditor` is `undefined` (custom editor
   is active).
2. `provider.getActiveDocUri()` returns the current document URI.
3. `provider.getLastWebviewScrollFraction(uri)` reads the last `scrollUpdate` value.
4. `provider.storePendingRawFraction(fraction)`.
5. `await toggleEditorType` opens the text editor.
6. `provider.consumePendingRawFraction()` is called; the fraction is converted to a line
   number and `editor.revealRange(range, AtTop)` scrolls the text editor.

---

# Raw → Preview (status: **not working — scroll does not restore**)

## Intent

1. Toggle command fires. `vscode.window.activeTextEditor` is the raw text editor.
2. `topLine / lineCount` fraction is captured.
3. Fraction stored in provider's `pendingPreviewFractions` map (keyed by document URI).
4. `await toggleEditorType` shows the webview panel.
5. Webview receives a `scrollToFraction` message and scrolls.

## Attempts and findings

### Attempt 1 — send from `onDidChangeViewState`

The initial implementation sent `scrollToFraction` inside the `onDidChangeViewState` handler
when `webviewPanel.visible` became true.

**Why it failed**: `onDidChangeViewState` may not fire at all for the toggle transition.
`workbench.action.toggleEditorType` can show the custom editor panel without changing its
view state (the panel may already be marked as visible by the time the handler is registered
inside `resolveCustomTextEditor`). In that case the handler is never invoked for the
initial show, so `scrollToFraction` is never sent.

### Attempt 2 — provider-level `pendingPreviewFractions` map + `isInitialized` gate

The state was moved from `PanelScrollState` (which is deleted/recreated by
dispose/resolveCustomTextEditor cycles) to a separate provider-level
`pendingPreviewFractions: Map<string, number>` that survives those cycles.

In `SyncClient`:
- `isInitialized: boolean` tracks whether the `init` message (which sets TipTap content) has
  been processed.
- `pendingScrollFraction: number | null` buffers a `scrollToFraction` that arrived before
  content was in the DOM. Applied (with `requestAnimationFrame`) after `init` sets content.

**Why it still failed**: The `onDidChangeViewState` root cause was not addressed. The fraction
never reached the webview.

### Attempt 3 — direct flush from `extension.ts` after `await toggleEditorType`

After `await vscode.commands.executeCommand('workbench.action.toggleEditorType')` resolves,
`resolveCustomTextEditor` has already run (it is synchronous internally) and the
`scrollStates` entry exists. `provider.flushPendingPreviewScroll(uri)` was added to send
`scrollToFraction` directly, independent of `onDidChangeViewState`:

```typescript
// extension.ts — after await toggleEditorType
if (previewDocUri) {
    provider.flushPendingPreviewScroll(previewDocUri);
}
```

```typescript
// markdownEditorProvider.ts
flushPendingPreviewScroll(docUri: string): void {
    const fraction = this.pendingPreviewFractions.get(docUri);
    if (fraction === undefined) return;
    const state = this.scrollStates.get(docUri);
    if (!state) return;
    this.pendingPreviewFractions.delete(docUri);
    state.webview.postMessage({ type: 'scrollToFraction', fraction });
}
```

**Current status**: Issue is still present. Scroll does not restore on raw → preview toggle.

---

# Remaining unknowns / hypotheses

The following have not yet been ruled out:

1. **`flushPendingPreviewScroll` finds no state entry**: `scrollStates.get(docUri)` returns
   `undefined` if `resolveCustomTextEditor` has not been called for the URI, or if
   `onDidDispose` cleared the entry and `resolveCustomTextEditor` has not re-run by the time
   the flush executes. Confirm by logging whether `state` is truthy inside the method.

2. **URI mismatch**: `textEditor.document.uri.toString()` (from the raw text editor) might
   produce a different string than `document.uri.toString()` inside
   `resolveCustomTextEditor`. This could happen if VS Code normalises the URI differently for
   each editor type (e.g. adds/removes a trailing slash, changes casing on macOS).

3. **VS Code scroll reset after webview show**: After `await toggleEditorType` the webview
   becomes visible. Electron/VS Code may reset `window.scrollY` to 0 as part of the
   show transition. If this happens *after* our `requestAnimationFrame` callback fires,
   our scroll is overridden. Workaround: use `setTimeout(100)` instead of `rAF`.

4. **`scrollHeight - innerHeight` is 0 at scroll time**: If the webview layout has not been
   recalculated by the time `applyScrollFraction` runs, `scrollHeight` may equal
   `innerHeight` and the scroll target computes to 0. A retry loop checking for
   `scrollable > 0` would mitigate this.

5. **`workbench.action.toggleEditorType` disposes the webview**: Despite
   `retainContextWhenHidden: true`, the toggle may dispose and recreate the webview panel.
   In this case the JS context restarts: `isInitialized` is reset to `false`,
   `currentVersion` is reset to `0`. The message ordering would be:
   `scrollToFraction` (buffered, from flush) → `externalUpdate v0` (dropped) → `init`
   (applies content, then applies pendingScrollFraction). This *should* work with the current
   code but has not been confirmed.

---

# Files changed

| File | Change |
|------|--------|
| `src/sync/syncProtocol.ts` | Added `ScrollToFractionMessage`, `ScrollUpdateMessage`; updated union types |
| `src/webview/syncClient.ts` | Debounced `scroll` listener → `scrollUpdate`; `scrollToFraction` handler with `isInitialized` gate; `pendingScrollFraction` buffer applied after `init` |
| `src/markdownEditorProvider.ts` | `scrollStates` map; `pendingPreviewFractions` map; `scrollUpdate` handler; `onDidChangeViewState` fallback; `flushPendingPreviewScroll`, `setPendingPreviewFraction`, `getLastWebviewScrollFraction`, `getActiveDocUri`, `storePendingRawFraction`, `consumePendingRawFraction` |
| `src/extension.ts` | Toggle command captures fraction before toggle, calls `flushPendingPreviewScroll` and `revealRange` after |

---

# Suggested next debugging steps

1. Add `console.log` (visible in the Extension Development Host's Debug Console) inside
   `flushPendingPreviewScroll` to confirm it is called and that both `fraction` and `state`
   are non-null.

2. Add `console.log` inside `handleMessage` case `'scrollToFraction'` in `syncClient.ts`
   (visible in the webview's DevTools console via Help → Toggle Developer Tools) to confirm
   the message is received and the value of `isInitialized` at that moment.

3. Log `document.documentElement.scrollHeight` and `window.innerHeight` inside
   `applyScrollFraction` to verify `scrollable > 0`.

4. After confirming the message is received and scroll is applied, check 100 ms later
   whether `window.scrollY` is still at the expected value (to detect a post-scroll reset
   by VS Code).
