Spike 4 — commentPanel.ts refactorability

Status: REUSABLE
File: src/webview/commentPanel.ts (425 lines)

# Structural map

- Thread UI rendering: lines 201-273 (functions: `renderComment`, `renderPendingComment`)
- Supporting helpers (formatRelativeTime, formatLineHeader): lines 403-420
- Panel positioning / anchor-rect logic: lines 315-330 (function: `positionPanel`)
- Close handlers (click-outside, Escape): lines 332-354 (function: `registerCloseHandlers`)

# Answers

**Q1 — thread rendering isolation**: Thread rendering is cleanly isolated in two private methods: `renderComment` (lines 201-243) handles existing comments with author/timestamp/Outdated/Draft markers, and `renderPendingComment` (lines 245-273) handles pending entries with a Discard button. Both are called from `buildPanel` (lines 168-173) via a loop. The textarea and submit button (reply section) are built inline inside `buildPanel` at lines 180-196 but are gated behind the `hasPendingAlready` flag at line 179 — they are NOT entangled with the comment rendering loops. For LLM-Assist, skipping the `renderComment`/`renderPendingComment` loops (lines 168-173) and the `hasPendingAlready` guard entirely, while keeping only the reply section block (lines 180-196), requires no surgery on `buildPanel`'s structure — a `mode` parameter can gate those two loops.

**Q2 — positioning independence**: `positionPanel` (lines 315-330) calls only `anchorEl.getBoundingClientRect()` (line 317) and reads `window.innerWidth` (line 319). It has zero reference to thread state, comment arrays, `currentThreadId`, or any output of `renderComment`/`renderPendingComment`. It is fully independent of the thread-rendering path.

**Q3 — close handler independence**: `registerCloseHandlers` (lines 332-354) has one conditional at lines 336-337: on Escape it queries the panel for `.comment-reply-input` and suppresses close if the textarea is focused and non-empty — this is textarea-state, not thread state. It contains no reference to `currentThreadId`, comment arrays, pending counts, or reply-editing state beyond the textarea value check. The condition applies identically to LLM-Assist (where a user may be mid-draft); no changes are needed.

# Verdict

REUSABLE. Add a `mode: 'thread' | 'llm-assist'` parameter to `buildPanel` (and propagate it through `openNew`/`openThread`). When `mode === 'llm-assist'`:

1. Skip the `renderComment` loop at lines 168-169.
2. Skip the `renderPendingComment` loop at lines 171-173.
3. Remove the `hasPendingAlready` guard (lines 179-196) — always render the reply section (rename button label from "Queue" to "Ask" or "Submit").
4. Drop the `pendingComments` / `comments` opts fields or pass them empty.
5. `positionPanel` and `registerCloseHandlers` need zero changes.
6. `subscribeToStore` can be skipped entirely for LLM-Assist (pass `null` store or add an early-return guard at line 357).

Estimated LOC delta: ~30 lines of conditionals inside `buildPanel` plus a mode parameter threaded through two call sites.

# Evidence for HLD update

assumed → verified: the HLD claim that `commentPanel.ts` is reusable is correct. Thread UI is isolated in two leaf methods (`renderComment`, `renderPendingComment`) called from `buildPanel` loops, not interleaved with the textarea/submit path. Positioning and close handlers are fully independent of thread state.
