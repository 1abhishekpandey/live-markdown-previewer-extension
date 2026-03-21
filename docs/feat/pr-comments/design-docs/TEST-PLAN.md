PR Comments Integration - Test Plan

# Overview

Tests verify every extension-side component (gh CLI wrapper, PR detector, comment fetcher, comment poster, diff line mapper) and every webview-side component (pending store, comment toggle, comment panel, comment indicator plugin) plus their integration through the sync protocol.

**Strategy**: Unit tests run via Vitest with mocked `child_process.execFile` (extension side) and mocked `vscode` API / DOM (webview side). No VS Code host required. Integration verification uses the Extension Development Host (F5) against a real PR.

**Test location**: `src/__tests__/unit/` — matching the existing pattern. Each component gets its own test file.

**Run all**: `npm test`
**Run one file**: `npx vitest run src/__tests__/unit/<file>.test.ts`
**Watch mode**: `npm run test:watch`

---

# Component Tests

## ghCli.ts

### What to verify

- `execGh` returns stdout/stderr on success
- `execGh` throws `GhNotFoundError` on ENOENT
- `execGh` throws `GhApiError` with stderr and exitCode on non-zero exit
- `isGhAvailable` returns true/false based on `gh --version` result
- `isGhAuthenticated` returns true/false based on `gh auth status` result
- `isGhAuthenticated` re-throws `GhNotFoundError` (does not swallow it)
- `classifyGhError` maps stderr patterns to the correct category

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Successful gh call | mock execFile resolves with `{ stdout: "ok", stderr: "" }` | Returns `{ stdout: "ok", stderr: "" }` | `npx vitest run src/__tests__/unit/ghCli.test.ts` |
| 2 | gh not found | mock execFile rejects with `{ code: "ENOENT" }` | Throws `GhNotFoundError` | same |
| 3 | gh exits non-zero | mock execFile rejects with `{ stderr: "error msg", code: 1 }` | Throws `GhApiError` with `stderr: "error msg"`, `exitCode: 1` | same |
| 4 | isGhAvailable - found | mock `gh --version` succeeds | Returns `true` | same |
| 5 | isGhAvailable - not found | mock `gh --version` throws ENOENT | Returns `false` | same |
| 6 | isGhAuthenticated - authed | mock `gh auth status` succeeds | Returns `true` | same |
| 7 | isGhAuthenticated - not authed | mock `gh auth status` exits non-zero | Returns `false` | same |
| 8 | isGhAuthenticated - gh missing | mock throws ENOENT | Re-throws `GhNotFoundError` | same |
| 9 | classifyGhError - Bad credentials | stderr: `"Bad credentials"` | Returns `"token-expired"` | same |
| 10 | classifyGhError - token expired | stderr: `"token expired"` | Returns `"token-expired"` | same |
| 11 | classifyGhError - permission denied | stderr: `"Resource not accessible by integration"` | Returns `"permission-denied"` | same |
| 12 | classifyGhError - write access | stderr: `"Must have write access"` | Returns `"permission-denied"` | same |
| 13 | classifyGhError - PR closed | stderr: `"pull request is closed"` | Returns `"pr-closed"` | same |
| 14 | classifyGhError - stale SHA | stderr: `"commit_id is not part of the pull request"` | Returns `"stale-sha"` | same |
| 15 | classifyGhError - rate limit | stderr: `"API rate limit exceeded"` | Returns `"rate-limited"` | same |
| 16 | classifyGhError - unknown | stderr: `"something unexpected"` | Returns `"unknown"` | same |
| 17 | classifyGhError - case insensitive | stderr: `"BAD CREDENTIALS"` | Returns `"token-expired"` | same |

### Edge cases

- `execGh` receives empty stdout — should return `{ stdout: "", stderr: "" }` without throwing
- `execGh` receives both stdout and non-empty stderr on zero exit — should return both (gh sometimes writes warnings to stderr on success)

---

## prDetector.ts

### What to verify

- `detectPr` returns `PrInfo` when a PR exists
- `detectPr` returns `null` when no PR exists
- `detectPr` combines PR info with repo info in a single `PrInfo` object
- `getRepoInfo` extracts owner and repo from JSON output
- `openPrInBrowser` calls `gh pr view --web`

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | PR exists | mock `gh pr view` returns `{"number":42,"url":"...","headRefName":"feat","baseRefName":"main"}`, mock `gh repo view` returns `{"owner":{"login":"user"},"name":"repo"}` | `PrInfo` with all fields populated | `npx vitest run src/__tests__/unit/prDetector.test.ts` |
| 2 | No PR | mock `gh pr view` exits non-zero with "no pull requests found" | Returns `null` | same |
| 3 | PR closed | mock `gh pr view` exits non-zero with "pull request is closed" | Returns `null` | same |
| 4 | Not a git repo | mock `gh pr view` exits with "not a git repository" | Returns `null` | same |
| 5 | getRepoInfo | mock returns `{"owner":{"login":"org"},"name":"my-repo"}` | `{ owner: "org", repo: "my-repo" }` | same |
| 6 | openPrInBrowser | mock execGh | Called with `["pr", "view", "--web"]` | same |

### Edge cases

- `gh pr view` returns malformed JSON — should catch parse error and return `null` (or throw a meaningful error)
- `gh repo view` fails — `detectPr` should propagate the error (not silently return null)

---

## diffLineMapper.ts

### What to verify

- `parseDiffForFile` builds correct bidirectional maps from a single hunk
- Multi-hunk diffs produce correct maps across all hunks
- Added lines appear in `addedLines`, context and deleted lines do not
- File matching handles renames (a/ and b/ path prefixes)
- `validateLineMapping` returns diff line or null
- `validateMultiLineMapping` falls back to single-line when start is unmappable

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Single hunk - additions only | `@@ -1,3 +1,6 @@` with 3 context + 3 added lines | `addedLines` contains 3 entries; mapping correct for all 6 lines | `npx vitest run src/__tests__/unit/diffLineMapper.test.ts` |
| 2 | Single hunk - mixed | `@@ -10,6 +10,11 @@` with context, additions, deletions | Context lines mapped (not in addedLines); additions mapped (in addedLines); deletions not in either map | same |
| 3 | Multiple hunks | Two `@@` sections for same file | Maps span both hunks; diffPosition resets per hunk | same |
| 4 | File not in diff | diff for `other.md`, query for `target.md` | Empty maps, empty `addedLines` | same |
| 5 | Renamed file | `diff --git a/old.md b/new.md` | Matching by `b/new.md` succeeds | same |
| 6 | validateLineMapping - valid | workingCopyLine 15 in a populated mapping | Returns the corresponding diff line | same |
| 7 | validateLineMapping - invalid | workingCopyLine 999 not in mapping | Returns `null` | same |
| 8 | validateMultiLineMapping - both valid | endLine 20, startLine 15, both in mapping | Returns both diff lines | same |
| 9 | validateMultiLineMapping - start unmappable | endLine 20 valid, startLine 5 not in mapping | Returns `{ diffLine: <mapped>, diffStartLine: null }` (fallback to single-line) | same |
| 10 | validateMultiLineMapping - end unmappable | endLine not in mapping | Returns `{ diffLine: null, diffStartLine: null }` | same |
| 11 | validateMultiLineMapping - single line (startLine null) | endLine 20, startLine null | Returns `{ diffLine: <mapped>, diffStartLine: null }` | same |

### Edge cases

- Empty diff output — returns empty LineMapping
- Hunk header with no count (`@@ -1 +1,5 @@`, i.e. count omitted = 1) — parser should handle this
- `+` line at very end of file (no trailing newline) — should still be mapped
- Diff with `\ No newline at end of file` marker — should be skipped (not treated as +/-/context)
- Binary file marker (`Binary files differ`) — should be skipped
- File with spaces in path — diff header uses quotes, parser should handle

### Concrete diff sample for test #2

```
diff --git a/src/utils/parser.md b/src/utils/parser.md
index abc1234..def5678 100644
--- a/src/utils/parser.md
+++ b/src/utils/parser.md
@@ -10,6 +10,11 @@
 context line 10
 context line 11
 context line 12
+added line 13
+added line 14
+added line 15
+added line 16
+added line 17
 context line 18
```

Expected LineMapping:
- `diffLineToWorkingCopy`: { 1→10, 2→11, 3→12, 4→13, 5→14, 6→15, 7→16, 8→17, 9→18 }
- `workingCopyToDiffLine`: { 10→1, 11→2, 12→3, 13→4, 14→5, 15→6, 16→7, 17→8, 18→9 }
- `addedLines`: [ {13,"added"}, {14,"added"}, {15,"added"}, {16,"added"}, {17,"added"} ]

### Concrete diff sample with deletions

```
@@ -5,7 +5,6 @@
 context 5
 context 6
-deleted 7
-deleted 8
+replaced 7
 context 9
 context 10
```

Expected:
- diffPosition 1: context → wc 5
- diffPosition 2: context → wc 6
- diffPosition 3: deletion (old line 7) → no wc mapping
- diffPosition 4: deletion (old line 8) → no wc mapping
- diffPosition 5: addition → wc 7 (in addedLines)
- diffPosition 6: context → wc 8
- diffPosition 7: context → wc 9

---

## commentFetcher.ts

### What to verify

- Comments are filtered by file path (exact match)
- Threads are grouped correctly by `in_reply_to_id`
- Replies are sorted by `createdAt` within each thread
- Threads are sorted by `workingCopyLine`
- Outdated detection: `line === null && original_line !== null` → `isOutdated: true`
- `isOwn` set correctly based on current user
- Threads with unmappable lines are excluded
- `fetchCurrentUser` returns trimmed login

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Single thread, single comment | 1 root comment for target file | 1 thread with 1 comment | `npx vitest run src/__tests__/unit/commentFetcher.test.ts` |
| 2 | Thread with replies | 1 root + 2 replies (`in_reply_to_id` = root ID) | 1 thread with 3 comments, sorted by createdAt | same |
| 3 | Multiple threads | 3 root comments on different lines | 3 threads, sorted by workingCopyLine | same |
| 4 | File filtering | 5 comments: 2 for target file, 3 for other files | Only 2 comments returned | same |
| 5 | Outdated comment | Root comment with `line: null, original_line: 15` | `isOutdated: true` on the CommentData | same |
| 6 | Non-outdated comment | Root comment with `line: 8, original_line: 8` | `isOutdated: false` | same |
| 7 | isOwn - own comment | `user.login` matches currentUser | `isOwn: true` | same |
| 8 | isOwn - other's comment | `user.login` differs from currentUser | `isOwn: false` | same |
| 9 | Unmappable thread | Thread on a deleted line (line not in diffLineToWorkingCopy) | Thread excluded from result | same |
| 10 | Orphan reply | Reply with `in_reply_to_id` pointing to a non-existent root | Treated as new root thread | same |
| 11 | Multi-line thread | Root comment with `start_line: 18, line: 22` | Thread has both `diffStartLine` and `diffLine` set | same |
| 12 | Empty response | gh returns `[]` | Returns empty array | same |
| 13 | fetchCurrentUser | mock returns `"  myuser\n"` | Returns `"myuser"` (trimmed) | same |

### Edge cases

- Comment with `line: null` AND `original_line: null` — edge case (file-level comment). Should be excluded (no line to anchor).
- Paginated response — mock returns multiple pages (test that `--paginate` produces a contiguous array)
- Comment body with newlines, code blocks, emoji — preserved exactly, no transformation

---

## commentPoster.ts

### What to verify

- New comments batch: builds correct Review API request body
- Multi-line comments include `start_line` and `start_side`
- Replies are posted individually with `in_reply_to`
- Partial failure: failed replies returned in `failedReplyIds`
- Stubbed mode: logs to output channel, returns success
- `getLatestCommitSha` returns trimmed SHA

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Batch with new comments only | 2 new single-line comments | `execGh` called once with Review API; body has `event: "COMMENT"`, `comments` array of 2 | `npx vitest run src/__tests__/unit/commentPoster.test.ts` |
| 2 | Batch with multi-line comment | 1 comment with `diffStartLine: 5, diffLine: 10` | Request includes `start_line: 5, start_side: "RIGHT"` | same |
| 3 | Replies only | 2 replies, no new comments | 2 individual `execGh` calls with `in_reply_to`; no Review API call | same |
| 4 | Mixed batch | 1 new + 1 reply | Review API call first, then 1 reply call | same |
| 5 | Empty batch | No new comments, no replies | Returns `{ success: true }` (no-op) | same |
| 6 | Review API fails | mock Review API call throws | Returns `{ success: false, error: <message> }` | same |
| 7 | Partial reply failure | 2 replies, first succeeds, second fails | Returns `{ success: false, failedReplyIds: [<second tempId>] }` | same |
| 8 | All replies fail | 2 replies, both fail | Returns `{ success: false, failedReplyIds: [both tempIds] }` | same |
| 9 | getLatestCommitSha | mock returns `"abc123def456...\n"` | Returns trimmed 40-char SHA | same |
| 10 | Stubbed mode | Stubbed `submitReviewBatch` | Logs formatted output, returns `{ success: true }` | same |

### Edge cases

- Comment body with special JSON characters (quotes, backslashes, newlines) — must be properly escaped in the JSON payload sent to `gh api --input -`
- Very long comment body (>65K characters) — should still be sent; GitHub's limit is the constraint, not the extension

---

## pendingCommentStore.ts

### What to verify

- `add` appends and notifies listeners
- `remove` deletes by tempId and notifies
- `clear` empties everything and notifies
- `clearSuccessful` keeps only failed IDs
- `hydrate` replaces state without persisting
- Every mutating method (except `hydrate`) sends `savePendingQueue` message
- `onChange` returns a working unsubscribe function
- `getAll` returns a shallow copy (not a reference)

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Add comment | Call `add(comment)` | `getCount() === 1`, listener called, `savePendingQueue` sent | `npx vitest run src/__tests__/unit/pendingCommentStore.test.ts` |
| 2 | Remove comment | Add 2, `remove(first.tempId)` | `getCount() === 1`, remaining is the second | same |
| 3 | Remove non-existent | `remove("bogus")` | No error, count unchanged, listener still called | same |
| 4 | Clear | Add 3, `clear()` | `getCount() === 0`, `savePendingQueue` sent with `[]` | same |
| 5 | clearSuccessful - partial | Add 3 (A, B, C), `clearSuccessful(["B"])` | Only B remains | same |
| 6 | clearSuccessful - all failed | Add 2 (A, B), `clearSuccessful(["A", "B"])` | Both remain | same |
| 7 | clearSuccessful - none failed | Add 2, `clearSuccessful([])` | All cleared | same |
| 8 | Hydrate | Call `hydrate([comment1, comment2])` | `getCount() === 2`, listener called, `savePendingQueue` NOT sent | same |
| 9 | Hydrate then add | `hydrate([c1])`, then `add(c2)` | `getCount() === 2`, `savePendingQueue` sent only for add | same |
| 10 | Unsubscribe | Subscribe, unsubscribe, then add | Listener NOT called after unsubscribe | same |
| 11 | getAll returns copy | `getAll()`, mutate returned array | Internal array unaffected | same |
| 12 | get - found | Add comment with tempId "abc", `get("abc")` | Returns the comment | same |
| 13 | get - not found | `get("nonexistent")` | Returns `undefined` | same |

---

## Extension-Side Wiring (markdownEditorProvider.ts)

### What to verify

- `commentToggle` (enable) runs sequential checks then parallel fetch
- Dirty file check blocks toggle with correct error
- gh missing/auth failure blocks toggle with correct error
- No PR blocks toggle
- File not in diff blocks toggle
- `commentData` message is sent with correct shape
- `savedPendingQueue` is sent if workspaceState has data
- `commentToggle` (disable) clears line mapping and sets reviewModeActive false
- `commentRefresh` re-fetches and sends updated data
- `validateLine` returns correct mapping result
- `submitReview` splits pending, re-validates, posts, auto-refreshes on success
- `savePendingQueue` writes to workspaceState
- Error classification routes to correct message type

### Test cases

| # | Scenario | Input | Expected Output | How to Run |
|---|----------|-------|-----------------|------------|
| 1 | Toggle ON - happy path | Clean file, gh available, authed, PR exists, diff + comments return data | `commentData` sent with threads + diffHighlightLines | `npx vitest run src/__tests__/unit/commentMessageHandler.test.ts` |
| 2 | Toggle ON - dirty (uncommitted) | mock `git diff HEAD` returns non-empty | `commentError` sent with dirty file message | same |
| 3 | Toggle ON - dirty (unpushed) | mock `git diff` empty but `git log @{u}..HEAD` returns non-empty | `commentError` sent with dirty file message | same |
| 4 | Toggle ON - gh not installed | `isGhAvailable` returns false | `commentError` sent with install message | same |
| 5 | Toggle ON - not authed | `isGhAuthenticated` returns false | `commentError` sent with auth message | same |
| 6 | Toggle ON - no PR | `detectPr` returns null | `commentError` sent with "No open PR" | same |
| 7 | Toggle ON - file not in diff | parseDiffForFile returns empty addedLines | `commentError` sent with "File has no changes" | same |
| 8 | Toggle ON - sends saved pending queue | workspaceState has 2 pending comments | `savedPendingQueue` sent with 2 items | same |
| 9 | Toggle ON - no saved pending | workspaceState is empty | `savedPendingQueue` not sent (or sent with empty array) | same |
| 10 | Toggle OFF | Previously ON | `cachedLineMapping` cleared, `reviewModeActive` = false | same |
| 11 | Refresh | Review mode ON, cached PR info | Fresh `commentData` sent with updated threads | same |
| 12 | Validate line - mappable | workingCopyLine 15 is in mapping | `lineMappingResult` with diffLine set | same |
| 13 | Validate line - unmappable | workingCopyLine 999 not in mapping | `lineMappingResult` with diffLine null, error message | same |
| 14 | Validate multi-line | endLine 20, startLine 15, both mappable | Both diffLine and diffStartLine set | same |
| 15 | Submit review - success | 2 new + 1 reply, poster returns success | `reviewSubmitResult { success: true }`, auto-refresh triggered | same |
| 16 | Submit review - partial failure | Poster returns `failedReplyIds: ["x"]` | `reviewSubmitResult` with failedReplyIds | same |
| 17 | Submit review - full failure | Poster throws | `reviewSubmitResult { success: false, error }` | same |
| 18 | Submit review - line unmappable after re-validation | Fresh diff mapping invalidates a comment's line | Error included in result | same |
| 19 | Save pending queue | `savePendingQueue` message received | `workspaceState.update` called with correct data | same |
| 20 | Token expired mid-refresh | API call returns 401 | `commentError` with re-auth message | same |
| 21 | PR info cached | Toggle ON twice | `detectPr` called only once | same |
| 22 | Current user cached | Toggle ON, refresh | `fetchCurrentUser` called only once | same |

### Edge cases

- `commentOpenPr` — verify `gh pr view --web` is called (fire-and-forget, no error sent to webview)
- Two rapid toggle ON clicks — second should be ignored while first is in progress (or queued)
- Refresh while submit is in progress — should wait or queue

---

# Integration Tests (Extension Development Host)

These tests run manually in the Extension Development Host (F5) against a real GitHub PR.

## Flow 1: Toggle ON and View Comments

### Scenario

Open a markdown file on a branch with an open PR that has review comments on that file.

### Steps

1. Press F5 to launch the Extension Development Host
2. Open a markdown file that is part of the PR diff
3. Click the "Review" toggle button
4. Observe loading state on the button

### Expected Result

- Button updates to "Review: ON PR #123"
- Diff-highlighted lines appear with green background
- Comment indicators (badges) appear on lines with comments
- Editor becomes read-only (typing is disabled)
- Staleness indicator shows "Last refreshed just now"
- Refresh button appears
- Pending queue from prior session is restored (if any)

## Flow 2: Create and Queue Comment

### Scenario

Create a new comment on a highlighted line and queue it.

### Steps

1. Toggle review mode ON (from Flow 1)
2. Hover over a green-highlighted line — "+" button should appear
3. Click the "+" button — comment panel opens
4. Type "Test comment from extension" in the textarea
5. Click "Queue"

### Expected Result

- Panel shows "New comment on line N"
- After clicking Queue: comment appears in the panel with dashed border and "Pending" label
- Submit Review button appears: "Submit Review (1)"
- Badge on the line updates to show "+1"
- Discard button (X) is visible on the pending comment

## Flow 3: Multi-line Comment

### Scenario

Select text spanning multiple highlighted lines and create a comment.

### Steps

1. Toggle review mode ON
2. Select text that spans 3+ consecutive green-highlighted lines
3. Click the floating comment button that appears on the right
4. Type "Multi-line comment test"
5. Click "Queue"

### Expected Result

- Panel header shows "New comment on lines N-M"
- Pending comment added with both `workingCopyLine` and `workingCopyStartLine`
- Submit Review count increments

## Flow 4: Submit Review (Stubbed)

### Scenario

Submit queued comments (phases 1-7: writes to output channel, not GitHub).

### Steps

1. Queue 2 new comments and 1 reply to an existing thread
2. Click "Submit Review (3)"
3. Confirm in the confirmation prompt

### Expected Result

- Output channel (View → Output → LiveMarkdown) shows:
  ```
  Submit Review (3 comments to PR #123)
    [new] path/to/file.md:15 — "First comment"
    [new] path/to/file.md:22-28 — "Multi-line comment"
    [reply] thread #456 — "Reply text"
  ```
- Pending comments are cleared
- Comments auto-refresh
- Success checkmark appears on the submit button

## Flow 5: Submit Review (Real — Phase 8+)

### Scenario

Submit queued comments that actually post to GitHub.

### Steps

1. Queue 1 new comment + 1 reply
2. Submit Review → Confirm
3. Open the PR on GitHub

### Expected Result

- Comments visible on GitHub PR page
- New comment appears at the correct diff line
- Reply appears in the correct thread
- One review notification (not two separate notifications)

## Flow 6: Error States

### Scenario

Verify all error categories display correctly.

### Steps

1. **gh not installed**: Temporarily rename `gh` binary; click toggle → "GitHub CLI not installed" notification
2. **Not authenticated**: Run `gh auth logout`; click toggle → "Not authenticated" notification
3. **Dirty file**: Make an uncommitted change; click toggle → "local changes" error tooltip
4. **No PR**: Checkout a branch with no PR; click toggle → "No open PR" tooltip
5. **File not in diff**: Open a file that wasn't changed in the PR; click toggle → "no changes" tooltip

### Expected Result

- Each error shows the correct message as specified in the error handling table
- Toggle stays OFF in all cases
- No unhandled exceptions in the Developer Console

## Flow 7: Refresh and Staleness

### Scenario

Verify manual refresh and staleness indicator.

### Steps

1. Toggle ON
2. Wait 2 minutes
3. Check staleness indicator
4. Have someone add a comment to the PR on GitHub
5. Click Refresh
6. Verify the new comment appears

### Expected Result

- Staleness shows "Last refreshed 2 min ago"
- After refresh: new comment appears, staleness resets to "just now"

## Flow 8: Pending Queue Persistence

### Scenario

Verify pending comments survive a VS Code reload.

### Steps

1. Toggle ON, queue 2 comments
2. Reload VS Code window (Cmd+Shift+P → Developer: Reload Window)
3. Toggle ON again

### Expected Result

- After reload + toggle ON: 2 pending comments are restored
- Submit Review shows "(2)"
- Pending comments display correctly in the panel

## Flow 9: Toggle OFF and Cleanup

### Scenario

Verify all UI clears when review mode is toggled off.

### Steps

1. Toggle ON (comments loaded, diff highlights visible, 1 pending comment queued)
2. Click "Review: ON PR #123" to toggle OFF

### Expected Result

- All green highlights removed
- All comment indicators removed
- Panel closes (if open)
- Editor becomes editable again
- Refresh, Submit Review, staleness indicator all hidden
- Button reverts to "Review"
- Pending comments preserved in workspaceState (not cleared)

## Flow 10: Degraded Mode

### Scenario

Simulate diff fetch failure.

### Steps

1. This requires either: a private repo where the token lacks diff access, or temporarily mocking `fetchDiff` to throw
2. Toggle ON

### Expected Result

- Existing comments display with "~Line N" prefix
- "+" hover button does NOT appear
- Text selection does NOT show comment button
- Banner: "Diff unavailable — comment positions may be inaccurate. New comments disabled."
- Reply to existing threads still works

## Flow 11: Theme Integration

### Scenario

Verify visual correctness across VS Code themes.

### Steps

1. Toggle ON with comments and diff highlights
2. Switch to a light theme (e.g., Light+)
3. Switch to a dark theme (e.g., Dark+)
4. Switch to a high-contrast theme

### Expected Result

- Green diff highlights readable in all themes
- Comment panel text legible in all themes
- Badges, buttons, and indicators maintain contrast
- No hard-coded colours visible (everything uses `--vscode-*` variables)

---

# Verification Checklist

## Unit Tests

- [ ] ghCli.ts: all 17 test cases pass (execGh, isGhAvailable, isGhAuthenticated, classifyGhError)
- [ ] prDetector.ts: all 6 test cases pass (detectPr, getRepoInfo, openPrInBrowser)
- [ ] diffLineMapper.ts: all 11 test cases pass + edge cases (single hunk, multi-hunk, renames, deletions)
- [ ] commentFetcher.ts: all 13 test cases pass (filtering, threading, outdated, isOwn, unmappable exclusion)
- [ ] commentPoster.ts: all 10 test cases pass (batch, replies, partial failure, stubbed mode)
- [ ] pendingCommentStore.ts: all 13 test cases pass (add, remove, clear, clearSuccessful, hydrate, persistence)
- [ ] Extension wiring: all 22 test cases pass (toggle flow, dirty check, error routing, submit, cache)
- [ ] Existing tests unbroken: `npm test` passes with all prior 74 tests + new tests

## Integration (Extension Development Host)

- [ ] Flow 1: Toggle ON shows diff highlights, comment indicators, read-only mode
- [ ] Flow 2: Queue new comment via "+" button, badge updates, Submit button appears
- [ ] Flow 3: Multi-line comment panel header shows "lines N-M"
- [ ] Flow 4: Stubbed submit logs correct format to output channel
- [ ] Flow 5: Real submit posts comments to GitHub (Phase 8+)
- [ ] Flow 6: All 5 error categories show correct messages, toggle stays OFF
- [ ] Flow 7: Staleness indicator updates, refresh loads new comments
- [ ] Flow 8: Pending comments survive VS Code reload
- [ ] Flow 9: Toggle OFF clears all UI, editor becomes editable
- [ ] Flow 10: Degraded mode shows approximate positions, disables new comments
- [ ] Flow 11: Theme integration — all 3 themes render correctly

## Edge Cases

- [ ] Diff with no-newline-at-end marker parsed correctly
- [ ] Renamed file detected in diff
- [ ] Orphan reply treated as root thread
- [ ] Comment body with special characters preserved through round-trip
- [ ] Empty diff returns empty LineMapping (no crash)
- [ ] Rapid double-toggle does not corrupt state
- [ ] 1-hour TTL auto-clears data and shows expiry message
