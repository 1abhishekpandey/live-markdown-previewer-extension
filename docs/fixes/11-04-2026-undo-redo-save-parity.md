VS Code Parity for Undo, Redo, and Save Timing

# Problem

Three user-visible issues, reported and fixed in a single session:

1. **Ctrl+Z skipped a step.** Typing a word and pressing Ctrl+Z quickly reverted "the last to last change" instead of the word just typed. The undo reached one step too far into history.
2. **Saves felt delayed.** Edits landed in the `TextDocument` with a perceptible lag, so VS Code's own `files.autoSave` timer fired noticeably later than native editors.
3. **Opening a file took 8 seconds** after the first round of fixes. A loading overlay stayed on top of a fully-rendered document until a safety timeout fired.

The goal was full behavioural parity with VS Code's native editor and Microsoft Word:

- Type a word, pause, type another word. Ctrl+Z removes the second word, next Ctrl+Z removes the first. All keystrokes are persisted immediately.

# Root Causes

## 1. Undo skip — race between debounced edits and `executeCommand('undo')`

The original architecture kept TipTap's history disabled and forwarded Ctrl+Z / Ctrl+Shift+Z to the extension as `undo` / `redo` messages. The extension called `vscode.commands.executeCommand('undo')` on the backing `TextDocument`. Webview edits reached the `TextDocument` via a 300 ms debounced `edit` message.

When the user typed and pressed Ctrl+Z within 300 ms, the pending debounced edit had not yet been applied to the `TextDocument`. The sequence was:

1. User types "four" → TipTap fires `update` → `debouncedSendEdit` sets a 300 ms timer. `TextDocument` still shows "one two three".
2. User presses Ctrl+Z → webview immediately posts `{ type: 'undo' }`.
3. Extension calls `executeCommand('undo')` → VS Code reverts the last committed edit on the `TextDocument`, which is "three" (the last one that actually landed), not "four" (still in-flight).
4. `handleDocumentChange` fires → `externalUpdate("one two")` sent to the webview, buffered behind the still-running debounce.
5. The debounce fires → `sendEdit("one two three four")` posts the current TipTap state. Extension applies it on top of the undone state.
6. Buffered `externalUpdate("one two")` is then applied back to TipTap.

Net effect: the editor shows "one two" — the "three" step has been skipped, and the `TextDocument` undo history is now inconsistent with the visible view.

The race is fundamental to the decoupled architecture: any debounce window between TipTap and `TextDocument` creates a gap where the extension's undo sees stale state.

## 2. Save delay — debounce window was the save floor

Even with a tight 150 ms debounce, every edit waited at least 150 ms to reach the `TextDocument`. VS Code's `files.autoSave` then added its own delay on top (default 1 000 ms for `afterDelay`). Users with `autoSaveDelay: 0` still saw the 150 ms floor.

## 3. Slow file open — hallucinated `clearHistory` command

After the architectural rewrite (see Fix section), the code called `this.editor.commands.clearHistory()` to prevent the initial `setContent` from becoming an undoable step. This command **does not exist** in `@tiptap/extension-history` — only `undo` and `redo` are registered. It had been added to TypeScript via a `declare module` augmentation, so the compiler accepted it, but at runtime it resolved to `undefined` and calling it threw `TypeError: editor.commands.clearHistory is not a function`.

The exception was thrown inside `handleMessage('init')` before `onFirstInit()` ran. `onFirstInit` is the callback that hides `#loading-overlay` (wired in `src/webview/index.ts`). Because the call path aborted, the overlay stayed up until the 8 000 ms safety timeout in `src/webview/index.ts:28` fired on its own.

# Fix

The root solution reverses the original architectural choice: give undo/redo to TipTap, give save to VS Code's autosave, and keep the two sides loosely coupled via immediate edit dispatch.

## 1. Re-enable TipTap's History extension

`src/webview/editor.ts`:

```ts
StarterKit.configure({
  history: { newGroupDelay: 500 },
  codeBlock: false,
}),
```

`newGroupDelay: 500` matches ProseMirror's default and produces the word/pause batching behaviour VS Code and Word use: consecutive keystrokes within 500 ms collapse into one undo group, a pause of more than 500 ms starts a new group. Undo and redo are now handled entirely inside the webview by TipTap's own keymap (`Mod-z`, `Shift-Mod-z`, `Mod-y`).

## 2. Remove the debounced edit pipeline

`src/webview/syncClient.ts`:

- The `debounceTimer`, `debounceDelayInMs`, `pendingExternalUpdate`, `setAdaptiveDebounce`, and `debouncedSendEdit` members are gone.
- The `editor.on('update')` handler now calls `sendEdit()` synchronously:

```ts
this.editor.on('update', () => {
  if (this.isExternalUpdate) return;
  this.sendEdit();
});
```

Every keystroke dispatches `workspace.applyEdit` immediately. Because `applyEdit` marks the `TextDocument` dirty on every call, VS Code's built-in `files.autoSave` picks it up per the user's own setting — the extension writes no save logic of its own.

## 3. Stop intercepting Cmd+Z / Cmd+Y in the webview

`setupKeyboardShortcuts` only intercepts Ctrl+S now. The `undo` and `redo` message types were removed from `src/sync/syncProtocol.ts` and from the `processMessage` switch in `src/sync/documentSync.ts`. TipTap's built-in history keymap handles Cmd+Z, Cmd+Shift+Z, and Cmd+Y locally.

## 4. Suppress history on initial content and external updates

An initial `setContent` would otherwise register as the first undoable step — Cmd+Z after opening a file would wipe the document to empty. External updates from other sources (git pulls, edits made from another editor) would similarly pollute the local undo stack.

The original attempt used `editor.commands.clearHistory()`, which does not exist (see Root Cause 3). The working mechanism is ProseMirror's `addToHistory: false` transaction meta, verified in `node_modules/prosemirror-history/src/history.ts:277`:

```ts
} else if (tr.getMeta("addToHistory") !== false && !(appended && appended.getMeta("addToHistory") === false)) {
```

When a transaction carries `addToHistory: false`, the history plugin skips tracking it entirely. TipTap's `chain()` accumulates multiple commands into a single transaction, which lets us attach the meta on the same `tr` as the `setContent`:

```ts
this.editor
  .chain()
  .setContent(msg.markdown)
  .command(({ tr }) => {
    tr.setMeta('addToHistory', false);
    return true;
  })
  .run();
```

Both call sites — `handleMessage` case `'init'` and `applyExternalUpdate` — use this pattern. The hallucinated `declare module` augmentation for `clearHistory` was removed.

## 5. Serialize webview messages on the extension side

`src/sync/documentSync.ts` now chains message handling through a promise queue:

```ts
private messageQueue: Promise<void> = Promise.resolve();

async handleWebviewMessage(msg: WebviewToExtensionMessage): Promise<void> {
  this.messageQueue = this.messageQueue
    .then(() => this.processMessage(msg))
    .catch((err) => {
      console.error('[LiveMarkdown] messageQueue error:', err instanceof Error ? err.message : err);
    });
  return this.messageQueue;
}
```

The switch body moved into a private `processMessage`. The `.catch` on the chain is load-bearing: an unhandled rejection would permanently stall the queue for all future messages. With `undo`/`redo` no longer going through the extension this is less critical than before, but it still protects against edit-ordering races if any future code posts multiple messages back-to-back without awaiting.

# Files Changed

- `src/webview/editor.ts` — `history: false` → `history: { newGroupDelay: 500 }` in StarterKit
- `src/webview/syncClient.ts` — removed debounce pipeline, `flushPendingEdit`, Cmd+Z / Cmd+Shift+Z interception, and the hallucinated `clearHistory` augmentation; added chain-based `addToHistory: false` pattern in `'init'` case and `applyExternalUpdate`; `editor.on('update')` now calls `sendEdit` synchronously
- `src/sync/documentSync.ts` — added `messageQueue` serialization, split switch into `processMessage`, removed `'undo'` and `'redo'` cases
- `src/sync/syncProtocol.ts` — removed `UndoMessage` and `RedoMessage` from the union
- `src/__tests__/unit/syncClient.handleMessage.test.ts` — mock editor now exposes `chain()` returning a chainable object; tests for init/externalUpdate history suppression assert the `command` callback sets `addToHistory: false`; obsolete flush-before-undo and adaptive-debounce tests removed
- `src/__tests__/unit/syncClient.scrollAnchor.test.ts` — same mock update
- `src/__tests__/unit/documentSync.test.ts` — removed tests for undo/redo message handling and the edit-then-undo serialization test (both no longer applicable)

# Why This Matches VS Code Native

- **Undo granularity**: TipTap's History with `newGroupDelay: 500` uses the same word/pause batching model as ProseMirror and VS Code's native text editor. Keystroke runs collapse, pauses break the group.
- **Save latency**: There is no extension-owned delay. Every keystroke marks the `TextDocument` dirty synchronously, so `files.autoSave` sees the edit the moment it happens. User-configured `autoSaveDelay` is the only wait.
- **Undo stack isolation**: External updates use `addToHistory: false`, so remote changes cannot pollute the local undo stack — pressing Cmd+Z after a git pull does not undo the pull.
- **Initial load**: The `'init'` transaction also carries `addToHistory: false`, so Cmd+Z after opening a file does nothing (empty history) rather than wiping the document to blank.

# The `clearHistory` Gotcha

The hallucinated command came from an LLM suggesting `editor.commands.clearHistory()` as if it were a standard TipTap API. Two details let it survive code review:

1. A `declare module '@tiptap/core'` augmentation was added to "work around missing .d.ts", which silenced TypeScript.
2. Test mocks included `clearHistory: vi.fn()`, so unit tests happily passed.

The failure only showed up in the integration path: the thrown `TypeError` aborted `handleMessage('init')` after `setContent` had rendered the DOM, so the content was visible underneath the overlay but the overlay never went away. The safety timeout in `src/webview/index.ts:28` eventually fired, which is why the file "appeared" 8 seconds later instead of never.

Lesson for the future: when augmenting a module interface, verify the command exists at runtime (`grep clearHistory node_modules/@tiptap/extension-history/dist`) before committing.

# Verification

- `npm test` — 300/300 tests pass across 19 files
- `npm run check-types` — clean
- Manual:
  - Type "asaksjaks", pause >500 ms, type "ajakjskd", press Ctrl+Z → "ajakjskd" disappears, "asaksjaks" remains. Next Ctrl+Z → "asaksjaks" disappears.
  - With `files.autoSave: afterDelay` and `files.autoSaveDelay: 0`, every keystroke is written to disk with no perceptible delay.
  - Opening any `.md` file renders immediately — no loading overlay dwell.
