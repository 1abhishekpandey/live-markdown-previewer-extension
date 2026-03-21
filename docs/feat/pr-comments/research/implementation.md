PR Comments - Implementation Plan

# Tracking

Each phase has a status marker. Update it as work progresses:

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — done

Do not start a phase until all its prerequisites are marked `[x]`.

# Strategy: Real Reads, Stubbed Writes

All gh CLI operations that **read** data use the real `gh` CLI from the start. This means real PR detection, real comment fetching, real diff fetching, real auth checks, and real dirty file detection. The feature works end-to-end against actual GitHub PRs throughout development.

The only thing stubbed is **posting comments**. Instead of calling the GitHub API, `submitReviewBatch()` logs each pending comment to the VS Code output channel in git-style format:

```
Submit Review (3 comments to PR #123)
  [new] path/to/file.md:15 — "Fix this typo"
  [new] path/to/file.md:22-28 — "This section needs rewriting"
  [reply] thread #101 — "Agreed, will fix"
```

This lets us verify the entire feature with real data — real comments appear, real diff lines are highlighted, real threads are displayed. The only difference is that "Submit Review" writes to the terminal instead of GitHub.

The final phase swaps in the real posting logic and verifies comments appear on GitHub.

# Phase 0: Line Mapping Prototype `[ ]`

**Prerequisite for all other phases.** Validate WYSIWYG-to-markdown line mapping accuracy before building the full feature.

**Goal**: Determine if TipTap block node indices reliably map to markdown line numbers for representative content.

**Tasks**:
- [ ] Create a test harness that takes a markdown file, parses it with TipTap, and outputs the block-node-index-to-line-number mapping
- [ ] Test with representative files: simple paragraphs, headings, lists, nested lists, tables, code blocks, mixed content
- [ ] Measure accuracy: what percentage of block nodes map to the correct markdown line?
- [ ] Document results and edge cases (which structures break the mapping?)
- [ ] Decision gate: if accuracy is below ~90%, revisit the approach before proceeding

**Output**: Accuracy report with pass/fail decision for proceeding.

# Phase 1: Types, Protocol & gh CLI Foundation `[ ]`

**Prerequisites**: Phase 0 `[x]`

**Goal**: Define all shared types, sync protocol messages, and build the real gh CLI wrapper, PR detection, comment fetching, and diff fetching. The only stubbed operation is comment posting (writes to terminal instead of GitHub).

**New files**:
- `src/sync/commentTypes.ts` — shared type definitions (PrInfo, CommentData, CommentThread, PendingComment, DiffLineInfo, LineMapping)
- `src/gh/ghCli.ts` — execFile wrapper, error classes (GhNotFoundError, GhAuthError, GhApiError), availability and auth checks
- `src/gh/prDetector.ts` — detect open PR, get repo info, open PR in browser
- `src/gh/commentFetcher.ts` — fetch comments, group into threads, detect outdated, fetch current user
- `src/gh/commentPoster.ts` — stubbed: logs to output channel in git-style format instead of posting to GitHub

**Modified files**:
- `src/sync/syncProtocol.ts` — add comment-related message types to both unions

**Tasks**:
- [ ] Define all shared types in `commentTypes.ts`
- [ ] Add Extension-to-Webview messages: `CommentDataMessage` (with `diffHighlightLines`, `lastFetchedAt`), `ReviewSubmitResult`, `CommentError`, `LineMappingResult`
- [ ] Add Webview-to-Extension messages: `CommentToggleMessage`, `CommentRefreshMessage`, `CommentOpenPrMessage`, `ValidateLineMessage`, `SubmitReviewMessage`
- [ ] Update union types in `syncProtocol.ts`
- [ ] Implement `ghCli.ts` with `execGh()`, `isGhAvailable()`, `isGhAuthenticated()`
- [ ] Implement `prDetector.ts` with `detectPr()`, `getRepoInfo()`, `openPrInBrowser()`
- [ ] Implement `commentFetcher.ts` with `fetchComments()`, `fetchCurrentUser()` — real API calls with pagination
- [ ] Implement outdated detection: `line === null && original_line !== null`
- [ ] Implement dirty file check: `git diff HEAD -- <file>` + `git log @{u}..HEAD -- <file>`
- [ ] Implement stubbed `commentPoster.ts`:
  - `submitReviewBatch()` → logs each comment in git-style format to the output channel, returns success
  - `getLatestCommitSha()` → real implementation (needed for future swap)
- [ ] Add error handling for all 6 categories (terminal vs recoverable)
- [ ] Handle token expiry mid-session (map 401/403 to re-auth message)
- [ ] Parallelise independent gh calls: auth + PR detection sequential, then comments + diff + user in parallel
- [ ] Cache PR info + current user per session
- [ ] Write tests for gh CLI wrapper, PR detection, comment fetching (mock execFile)

# Phase 2: Diff Parsing & Line Mapping `[ ]`

**Prerequisites**: Phase 1 `[x]`

**Goal**: Parse real PR diffs and build bidirectional line mappings.

**New files**:
- `src/gh/diffLineMapper.ts` — parse diff hunks, build line mappings, identify added/modified lines, validate line mapping

**Tasks**:
- [ ] Implement `parseDiffForFile()` — extract hunks for a file, build `diffLineToWorkingCopy` and `workingCopyToDiffLine` maps
- [ ] Populate `addedLines` array (added/modified lines for diff highlighting)
- [ ] Implement `fetchDiff()` — real `gh pr diff {number}`, return raw output (re-fetched on every Refresh, not cached)
- [ ] Implement `validateLineMapping()` — check if a working-copy line maps to the diff
- [ ] Handle multi-line mapping: validate both start and end lines, fallback to single-line if only one maps
- [ ] Write tests with real diff output samples (single hunk, multi-hunk, renames, context lines)

# Phase 3: Extension-Side Wiring `[ ]`

**Prerequisites**: Phase 2 `[x]`

**Goal**: Wire up the extension side — handle toggle, fetch, post, and message routing. All reads are real gh CLI. Only posting is stubbed (logs to terminal).

**Modified files**:
- `src/markdownEditorProvider.ts` — instantiate gh services, wire comment message handlers, dirty file check, read-only toggle

**Tasks**:
- [ ] Wire toggle-on flow: real dirty check → real auth → real PR detect → real parallel fetch (comments + diff + user) → send `CommentDataMessage` with `diffHighlightLines`
- [ ] Wire refresh flow: real re-fetch comments + diff, send updated `CommentDataMessage`
- [ ] Wire submit flow: receive `SubmitReviewMessage`, log pending comments in git-style format via stubbed poster, return `ReviewSubmitResult`
- [ ] Wire line validation: receive `ValidateLineMessage`, use real `diffLineMapper`, return `LineMappingResult`
- [ ] Wire PR badge click: real `gh pr view --web`
- [ ] Set editor read-only on toggle ON, restore on toggle OFF
- [ ] Implement retry with full re-validation (SHA + line mapping)
- [ ] Write tests for message routing

# Phase 4: Webview — Diff Highlighting & Comment Indicators `[ ]`

**Prerequisites**: Phase 3 `[x]`

**Goal**: Render diff highlights (green background on added lines), comment indicators, and "+" hover button.

**New/modified files**:
- `src/webview/commentIndicator.ts` — ProseMirror plugin for diff highlights, comment badges, "+" hover button

**Tasks**:
- [ ] Implement diff highlight decorations (green background on added/modified lines from `diffHighlightLines`)
- [ ] Implement comment highlight decorations (subtle tint on lines with comments, dashed border for pending)
- [ ] Implement widget decorations (comment count badge on right edge)
- [ ] Implement "+" hover button on diff-highlighted lines (CSS hover or widget decoration)
- [ ] All decorations return `DecorationSet.empty` when toggle is OFF
- [ ] Add CSS styles using `--vscode-*` design tokens
- [ ] Write tests for decoration state management

# Phase 5: Webview — Comment Panel `[ ]`

**Prerequisites**: Phase 4 `[x]`

**Goal**: Build the right-margin floating comment panel.

**New files**:
- `src/webview/commentPanel.ts` — render panel, handle open/close, reply input, pending comments

**Tasks**:
- [ ] Implement panel rendering: header (line number, count, close button), scrollable thread, reply textarea, Queue button
- [ ] Implement one-panel-at-a-time behaviour
- [ ] Implement panel positioning (anchored to block node, repositions on scroll)
- [ ] Implement close behaviour (close button, Escape, click outside)
- [ ] Show outdated label (faded "Outdated") on outdated comments
- [ ] Show pending comments with dashed border and Discard (X) button
- [ ] Implement new-comment panel (from "+" button or text selection): "New comment on line N" / "lines N-M" header
- [ ] Implement floating comment button on text selection (Notion-style, right side)
- [ ] Validate line mapping before queuing (send `ValidateLineMessage`, disable Queue on failure)
- [ ] Add CSS styles for all panel states
- [ ] Write tests for panel open/close, pending comment add/discard

# Phase 6: Webview — Toolbar & Pending Store `[ ]`

**Prerequisites**: Phase 5 `[x]`

**Goal**: Build the Review toggle, Submit Review button, Refresh, staleness indicator, and pending comment store.

**New/modified files**:
- `src/webview/commentToggle.ts` — toolbar buttons and staleness indicator
- `src/webview/pendingCommentStore.ts` — local pending queue
- `src/webview/index.ts` — initialise all comment UI components

**Tasks**:
- [ ] Implement `pendingCommentStore.ts`: add, remove, get, getAll, getCount, clear, clearSuccessful, onChange
- [ ] Implement Review toggle: send `commentToggle`, update label to "Review: ON PR #123" (real PR number), set editor read-only
- [ ] Implement PR badge click: send `commentOpenPr`
- [ ] Implement Submit Review button: show count, confirmation prompt, disable on click (double-submit prevention), loading/success/error states
- [ ] Implement Refresh button: send `commentRefresh`
- [ ] Implement staleness indicator: display "Last refreshed N min ago", update every minute, 1-hour TTL auto-clear
- [ ] Wire everything together in `index.ts`
- [ ] Write tests for pending store, staleness TTL, toolbar state transitions

# Phase 7: End-to-End Verification (Stubbed Posting) `[ ]`

**Prerequisites**: Phase 6 `[x]`

**Goal**: Verify the entire feature works end-to-end against a real PR. Real comments load, real diff highlights show, only posting writes to the terminal.

**Tasks**:
- [ ] Test in Extension Development Host (F5) against a real PR:
  - Toggle ON → real PR detected, real diff highlights (green) appear, real comments load, editor becomes read-only
  - "+" hover button → comment panel opens on a real diff line
  - Text selection → floating comment button appears (Notion-style, right side)
  - Queue comment → appears as pending with dashed border
  - Discard pending → removed from queue
  - Submit Review → git-style log appears in output channel with real file path and line numbers
  - Refresh → real comments re-fetched, staleness indicator resets
  - Toggle OFF → all highlights/panels/indicators disappear, editor editable again
- [ ] Verify output channel logs match expected format:
  ```
  Submit Review (N comments to PR #123)
    [new] path/to/file.md:15 — "comment text"
    [new] path/to/file.md:22-28 — "multi-line comment text"
    [reply] thread #456 — "reply text"
  ```
- [ ] Test error states: no gh, no auth, no PR, dirty file, file not in diff
- [ ] Test cache behaviour: tab switch preserves cache, toggle OFF clears
- [ ] Verify outdated labels show on real outdated comments
- [ ] Verify multi-line comment headers show "lines N-M"
- [ ] Visual polish: theme integration (light/dark/high contrast), spacing, transitions
- [ ] Run full test suite (`npm test`) and fix any regressions

# Phase 8: Real Comment Posting `[ ]`

**Prerequisites**: Phase 7 `[x]`

**Goal**: Swap the stubbed poster for real GitHub API calls. This is the only change — everything else is already real.

**Modified files**:
- `src/gh/commentPoster.ts` — replace terminal logging with real API calls

**Tasks**:
- [ ] Implement real `submitReviewBatch()`:
  - Split pending into new comments + replies
  - New comments → `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `event: "COMMENT"`, `body: ""`, `comments: [{ path, line, start_line?, side, start_side?, body }]`
  - Replies → individual `POST /repos/{owner}/{repo}/pulls/{number}/comments` with `in_reply_to`
  - Handle partial failure (batch succeeds, some replies fail)
- [ ] Implement real `getLatestCommitSha()` (may already be done in Phase 1)
- [ ] Double-submit prevention already wired (button disabled on click)
- [ ] Test: queue comments, submit, verify they appear on the real GitHub PR
- [ ] Test: partial failure (simulate by replying to a deleted thread)
- [ ] Test: stale SHA error (push a commit, try to submit without refresh)

# Phase 9: Final Integration Testing `[ ]`

**Prerequisites**: Phase 8 `[x]`

**Goal**: Full end-to-end testing with real posting against real GitHub PRs.

**Tasks**:
- [ ] Test complete flow: toggle ON → view real comments → create new comment → queue → submit → verify on GitHub
- [ ] Test batch with replies: queue new comments + replies to existing threads, submit, verify all appear
- [ ] Test multi-line comments: select multiple highlighted lines, queue, submit, verify range on GitHub
- [ ] Test error recovery: network failure → retry → verify comment posted (check for duplicates)
- [ ] Test dirty file blocking: make local changes, verify toggle blocked
- [ ] Test token expiry: wait for token to expire (or simulate), verify re-auth message
- [ ] Test 1-hour TTL: verify cache clears after 1 hour
- [ ] Performance: measure toggle-on latency with parallelised gh calls
- [ ] Run full test suite (`npm test`) and fix any regressions
