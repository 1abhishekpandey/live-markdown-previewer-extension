PR Comments Integration - Low-Level Design

# Shared Types (`src/sync/commentTypes.ts`)

## Purpose

Single source of truth for all PR comment data structures used by both extension and webview.

## Type Definitions

### PrInfo

Represents a detected GitHub pull request.

| Field | Type | Description |
|-------|------|-------------|
| number | number | PR number (e.g. 123) |
| url | string | Full GitHub PR URL |
| headRefName | string | Head branch name |
| baseRefName | string | Base branch name |
| owner | string | Repository owner |
| repo | string | Repository name |

### CommentData

A single review comment within a thread.

| Field | Type | Description |
|-------|------|-------------|
| id | number | GitHub comment ID |
| author | string | GitHub login of the comment author |
| body | string | Raw comment text, preserved as-is (newlines, markdown, code blocks) |
| createdAt | string | ISO 8601 timestamp |
| isOwn | boolean | True if the comment author matches the current `gh` user |
| isOutdated | boolean | True if the code has changed since the comment was posted |

### CommentThread

A root comment plus its replies, anchored to a file line.

| Field | Type | Description |
|-------|------|-------------|
| id | number | Root comment ID (used as `in_reply_to` for replies) |
| path | string | File path relative to repo root |
| diffLine | number | End line in the diff (right side) |
| diffStartLine | number or null | Start line for multi-line ranges; null for single-line |
| workingCopyLine | number | Mapped end line in the working copy |
| workingCopyStartLine | number or null | Mapped start line; null for single-line |
| comments | CommentData[] | Ordered by `createdAt` ascending |

### PendingComment

A locally-queued comment not yet posted to GitHub.

| Field | Type | Description |
|-------|------|-------------|
| tempId | string | Client-generated UUID (crypto.randomUUID) |
| threadId | number or null | Null = new comment on a line; number = reply to an existing thread |
| body | string | Raw text, no transformation |
| workingCopyLine | number | End line in the working copy |
| workingCopyStartLine | number or null | Start line for multi-line; null for single-line |
| diffLine | number or null | Mapped diff end line; null if mapping not yet validated |
| diffStartLine | number or null | Mapped diff start line; null for single-line or not yet validated |

### DiffLineInfo

A single line eligible for diff highlighting.

| Field | Type | Description |
|-------|------|-------------|
| lineNumber | number | Working-copy line number (1-based) |
| type | "added" or "modified" | Change type |

### LineMapping

Bidirectional mapping between diff lines and working-copy lines for a single file.

| Field | Type | Description |
|-------|------|-------------|
| diffLineToWorkingCopy | Map<number, number> | Diff line number → working-copy line number |
| workingCopyToDiffLine | Map<number, number> | Working-copy line number → diff line number |
| addedLines | DiffLineInfo[] | All added/modified lines (for diff highlighting) |

---

# gh CLI Wrapper (`src/gh/ghCli.ts`)

## Purpose

Thin wrapper around `child_process.execFile` for all `gh` CLI interactions. Handles error classification.

## Error Classes

Three custom error classes, all extending `Error`:

- **GhNotFoundError** — `gh` binary not found on PATH. No extra fields.
- **GhAuthError** — `gh auth status` indicates not authenticated. No extra fields.
- **GhApiError** — Any other non-zero exit from `gh`. Fields: `stderr` (string), `exitCode` (number).

## Functions

### execGh

- **Input**: `args` (string array — the arguments after `gh`), `cwd` (string — working directory)
- **Output**: `{ stdout: string, stderr: string }`
- **Behaviour**:
  1. Call `child_process.execFile` with binary `"gh"`, the provided args, and `{ cwd }`
  2. If the process throws with `code === "ENOENT"`, throw `GhNotFoundError`
  3. If the process exits non-zero, throw `GhApiError` with stderr and exit code
  4. Return stdout and stderr on success

### isGhAvailable

- **Input**: `cwd` (string)
- **Output**: boolean
- **Behaviour**: Call `execGh(["--version"], cwd)`. Return true on success, false if `GhNotFoundError` is caught. Re-throw any other error.

### isGhAuthenticated

- **Input**: `cwd` (string)
- **Output**: boolean
- **Behaviour**: Call `execGh(["auth", "status"], cwd)`. Return true on success, false on `GhApiError`. Re-throw `GhNotFoundError`.

### classifyGhError

- **Input**: `error` (GhApiError)
- **Output**: An error category string used by the caller to decide display strategy
- **Behaviour**:
  1. If stderr contains `"Bad credentials"` or `"token expired"` → return `"token-expired"`
  2. If stderr contains `"Resource not accessible"` or `"Must have write access"` → return `"permission-denied"`
  3. If stderr contains `"pull request is closed"` → return `"pr-closed"`
  4. If stderr contains `"commit_id is not part of the pull request"` → return `"stale-sha"`
  5. If stderr contains `"rate limit"` → return `"rate-limited"`
  6. Otherwise → return `"unknown"`

All string matching is case-insensitive.

---

# PR Detector (`src/gh/prDetector.ts`)

## Purpose

Detect the open PR for the current branch, extract repo info, and open the PR in a browser.

## Functions

### detectPr

- **Input**: `cwd` (string)
- **Output**: PrInfo or null
- **Behaviour**:
  1. Call `execGh(["pr", "view", "--json", "number,url,headRefName,baseRefName"], cwd)`
  2. Parse stdout as JSON
  3. Call `getRepoInfo(cwd)` to get owner and repo
  4. Return a `PrInfo` object combining both results
  5. If `GhApiError` is caught (non-zero exit = no open PR), return null

### getRepoInfo

- **Input**: `cwd` (string)
- **Output**: `{ owner: string, repo: string }`
- **Behaviour**:
  1. Call `execGh(["repo", "view", "--json", "owner,name"], cwd)`
  2. Parse stdout as JSON
  3. Return `{ owner: json.owner.login, repo: json.name }`

### openPrInBrowser

- **Input**: `cwd` (string)
- **Output**: void
- **Behaviour**: Call `execGh(["pr", "view", "--web"], cwd)`. Fire-and-forget; log errors to output channel.

---

# Comment Fetcher (`src/gh/commentFetcher.ts`)

## Purpose

Fetch all PR review comments, filter to the current file, group into threads, detect outdated status.

## Functions

### fetchComments

- **Input**: `pr` (PrInfo), `filePath` (string — repo-relative path), `lineMapping` (LineMapping), `currentUser` (string), `cwd` (string)
- **Output**: CommentThread[]
- **Behaviour**:
  1. Call `execGh(["api", "repos/{owner}/{repo}/pulls/{number}/comments", "--paginate"], cwd)` with owner/repo/number interpolated from `pr`
  2. Parse stdout as JSON array
  3. Filter: keep only comments where `path === filePath`
  4. Group into threads using the algorithm below
  5. For each thread, map diff lines to working-copy lines using `lineMapping`
  6. Exclude threads where the working-copy line cannot be mapped (comments on deleted lines)
  7. Sort threads by `workingCopyLine` ascending
  8. Return the thread array

### Thread grouping algorithm

1. Separate comments into two sets: root comments (`in_reply_to_id` is absent/null) and reply comments (`in_reply_to_id` is present)
2. Create a map: root comment ID → CommentThread
3. For each root comment:
   - Create a `CommentThread` with `id = comment.id`, `path = comment.path`
   - Set `diffLine` from the comment's `line` field (right-side line in diff)
   - Set `diffStartLine` from `start_line` if present, else null
   - Detect outdated: if `line === null && original_line !== null` → `isOutdated = true` for this comment
   - Set `isOwn = (comment.user.login === currentUser)`
   - Add the root comment as the first entry in `comments[]`
4. For each reply comment:
   - Find the thread by `in_reply_to_id`
   - If found, append to that thread's `comments[]`
   - If not found (orphan reply), treat as a new root thread
5. Sort each thread's `comments[]` by `createdAt` ascending

### Outdated detection

Per comment: `line === null && original_line !== null`. This uses fields already present in the REST API response — no additional API call needed.

The `line` field in GitHub's REST API is the right-side diff line for the comment's current position. When the underlying code changes (new commits push to the PR), GitHub sets `line` to null but preserves `original_line`.

### fetchCurrentUser

- **Input**: `cwd` (string)
- **Output**: string (GitHub login)
- **Behaviour**: Call `execGh(["api", "user", "--jq", ".login"], cwd)`. Return stdout trimmed.
- **Caching**: The caller (markdownEditorProvider) caches the result per session. This function does not cache internally.

---

# Comment Poster (`src/gh/commentPoster.ts`)

## Purpose

Post queued comments to GitHub as a batch review, plus individual replies.

## Types

### BatchSubmitResult

| Field | Type | Description |
|-------|------|-------------|
| success | boolean | True if all operations succeeded |
| error | string or undefined | Error message on full failure |
| failedReplyIds | string[] or undefined | tempIds of replies that failed (partial failure) |

## Functions

### submitReviewBatch

- **Input**: `pr` (PrInfo), `newComments` (PendingComment[]), `replies` (PendingComment[]), `commitSha` (string), `cwd` (string)
- **Output**: BatchSubmitResult
- **Behaviour**:
  1. **Post new comments as a batch review** (if `newComments` is non-empty):
     - Build the request body for `POST /repos/{owner}/{repo}/pulls/{number}/reviews`
     - `event`: `"COMMENT"`
     - `body`: `""` (empty — no review summary)
     - `commit_id`: the provided `commitSha`
     - `comments`: array of objects, one per new comment:
       - `path`: repo-relative file path
       - `line`: the comment's `diffLine`
       - `side`: `"RIGHT"`
       - `body`: the comment's `body` (raw text)
       - If multi-line (`diffStartLine` is not null):
         - `start_line`: the comment's `diffStartLine`
         - `start_side`: `"RIGHT"`
     - Call `execGh(["api", "--method", "POST", "repos/{owner}/{repo}/pulls/{number}/reviews", "--input", "-"], cwd)` with the JSON body piped to stdin
     - If this fails, return `{ success: false, error: <message> }`
  2. **Post replies individually** (if `replies` is non-empty):
     - For each reply, call `execGh(["api", "--method", "POST", "repos/{owner}/{repo}/pulls/{number}/comments", "--input", "-"], cwd)` with body: `{ body: reply.body, in_reply_to: reply.threadId }`
     - Collect failures: if a reply fails, record its `tempId`
     - If all replies succeed: return `{ success: true }`
     - If some fail: return `{ success: false, failedReplyIds: [<failed tempIds>] }`
  3. **Edge case: empty newComments + non-empty replies** — skip step 1, only post replies
  4. **Edge case: both empty** — return `{ success: true }` (no-op)

### getLatestCommitSha

- **Input**: `pr` (PrInfo), `cwd` (string)
- **Output**: string (40-char SHA)
- **Behaviour**: Call `execGh(["api", "repos/{owner}/{repo}/pulls/{number}", "--jq", ".head.sha"], cwd)`. Return stdout trimmed.

### Stubbed version (development)

During development (phases 1-7), `submitReviewBatch` logs to the VS Code output channel instead of posting:

```
Submit Review (3 comments to PR #123)
  [new] src/file.md:15 — "Fix this typo"
  [new] src/file.md:22-28 — "This section needs rewriting"
  [reply] thread #101 — "Agreed, will fix"
```

Always returns `{ success: true }`. The `getLatestCommitSha` function is real from the start.

---

# Diff Line Mapper (`src/gh/diffLineMapper.ts`)

## Purpose

Parse unified diff output, build bidirectional line mappings, and identify added/modified lines for highlighting.

## Functions

### fetchDiff

- **Input**: `pr` (PrInfo), `cwd` (string)
- **Output**: string (raw unified diff)
- **Behaviour**: Call `execGh(["pr", "diff", String(pr.number)], cwd)`. Return stdout.
- **Caching**: Not cached — re-fetched on every toggle-on and refresh.

### parseDiffForFile

- **Input**: `diffOutput` (string — full PR diff), `filePath` (string — repo-relative)
- **Output**: LineMapping
- **Behaviour**:
  1. Split diff output into file sections by `diff --git` headers
  2. Find the section matching `filePath` (check both `a/` and `b/` paths to handle renames)
  3. If no section found, return an empty LineMapping (empty maps, empty addedLines)
  4. Parse each hunk in the file section using the algorithm below
  5. Return the populated LineMapping

### Hunk parsing algorithm

For each `@@ -oldStart,oldCount +newStart,newCount @@` header:

1. Initialise `oldLine = oldStart`, `newLine = newStart`, `diffPosition = 1` (diff position is 1-based, starts after the `@@` line, counting all lines in the hunk)
2. For each subsequent line until the next `@@` or end of file section:
   - If the line starts with `+` (addition):
     - Add to `diffLineToWorkingCopy`: diffPosition → newLine
     - Add to `workingCopyToDiffLine`: newLine → diffPosition
     - Add to `addedLines`: `{ lineNumber: newLine, type: "added" }`
     - Increment `newLine`, increment `diffPosition`
   - If the line starts with `-` (deletion):
     - Increment `oldLine`, increment `diffPosition`
     - No mapping added (deleted lines have no working-copy counterpart)
   - If the line starts with ` ` (context):
     - Add to `diffLineToWorkingCopy`: diffPosition → newLine
     - Add to `workingCopyToDiffLine`: newLine → diffPosition
     - Do NOT add to `addedLines` (context lines are not commentable)
     - Increment both `oldLine` and `newLine`, increment `diffPosition`

**Important**: The `diffPosition` counter here represents the position within the diff hunk, which corresponds to GitHub's `line` field for review comments. GitHub counts diff positions starting from 1 after the hunk header, incrementing for every line (additions, deletions, and context lines all count).

**Note on "modified" vs "added"**: GitHub's unified diff format does not distinguish between modified and added lines — both appear as `+` lines. If a line was replaced (a `-` line immediately followed by a `+` line), the `+` line is functionally "modified", but we treat both identically as `"added"` in the type field. The distinction is cosmetic and does not affect behaviour.

### validateLineMapping

- **Input**: `workingCopyLine` (number), `mapping` (LineMapping)
- **Output**: number or null
- **Behaviour**: Look up `workingCopyLine` in `mapping.workingCopyToDiffLine`. Return the diff line if found, null if not.

### validateMultiLineMapping

- **Input**: `workingCopyLine` (number), `workingCopyStartLine` (number or null), `mapping` (LineMapping)
- **Output**: `{ diffLine: number or null, diffStartLine: number or null }`
- **Behaviour**:
  1. Look up the end line: `diffLine = validateLineMapping(workingCopyLine, mapping)`
  2. If `workingCopyStartLine` is null, return `{ diffLine, diffStartLine: null }`
  3. Look up the start line: `diffStartLine = validateLineMapping(workingCopyStartLine, mapping)`
  4. If `diffStartLine` is null but `diffLine` is not null, fall back to single-line: return `{ diffLine, diffStartLine: null }`
  5. Return `{ diffLine, diffStartLine }`

---

# Sync Protocol Additions (`src/sync/syncProtocol.ts`)

## Purpose

Extend the existing discriminated union message types with comment-related messages.

## New Extension → Webview Messages

### CommentDataMessage

Sent after successful toggle-on or refresh. Contains all data the webview needs to render.

| Field | Type | Description |
|-------|------|-------------|
| type | "commentData" | Discriminant |
| threads | CommentThread[] | All threads for the current file |
| prNumber | number | PR number |
| prUrl | string | Full GitHub PR URL |
| currentUser | string | GitHub login of the current user |
| diffHighlightLines | number[] | Working-copy line numbers to highlight green (added/modified) |
| lastFetchedAt | number | `Date.now()` timestamp when data was fetched |

### ReviewSubmitResultMessage

Sent after a batch review submission attempt.

| Field | Type | Description |
|-------|------|-------------|
| type | "reviewSubmitResult" | Discriminant |
| success | boolean | True if all operations succeeded |
| error | string or undefined | Error message on full failure |
| failedReplyIds | string[] or undefined | tempIds of failed replies (partial failure) |

### CommentErrorMessage

Sent when a comment operation fails (toggle blocked, auth failure, etc.).

| Field | Type | Description |
|-------|------|-------------|
| type | "commentError" | Discriminant |
| message | string | User-facing error message |
| details | string or undefined | Sanitised gh CLI stderr (for logging/debugging) |

### LineMappingResultMessage

Response to a line validation request.

| Field | Type | Description |
|-------|------|-------------|
| type | "lineMappingResult" | Discriminant |
| tempId | string | Matches the pending comment's tempId |
| diffLine | number or null | End diff line; null = unmappable |
| diffStartLine | number or null | Start diff line for multi-line; null for single-line or unmappable |
| error | string or undefined | Human-readable reason if null |

### SavedPendingQueueMessage

Sent on toggle-on to hydrate the webview's pending store from workspaceState.

| Field | Type | Description |
|-------|------|-------------|
| type | "savedPendingQueue" | Discriminant |
| pending | PendingComment[] | Previously persisted pending comments |

## New Webview → Extension Messages

### CommentToggleMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "commentToggle" | Discriminant |
| enabled | boolean | True = enable review mode, false = disable |

### CommentRefreshMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "commentRefresh" | Discriminant |

No additional fields.

### CommentOpenPrMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "commentOpenPr" | Discriminant |

No additional fields.

### ValidateLineMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "validateLine" | Discriminant |
| tempId | string | Client-generated ID for correlation |
| workingCopyLine | number | End line to validate |
| workingCopyStartLine | number or null | Start line for multi-line; null for single-line |

### SubmitReviewMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "submitReview" | Discriminant |
| pending | PendingComment[] | Full pending queue |

### SavePendingQueueMessage

| Field | Type | Description |
|-------|------|-------------|
| type | "savePendingQueue" | Discriminant |
| pending | PendingComment[] | Current pending queue state |

## Updated Union Types

**ExtensionToWebviewMessage** — add: `CommentDataMessage`, `ReviewSubmitResultMessage`, `CommentErrorMessage`, `LineMappingResultMessage`, `SavedPendingQueueMessage`

**WebviewToExtensionMessage** — add: `CommentToggleMessage`, `CommentRefreshMessage`, `CommentOpenPrMessage`, `ValidateLineMessage`, `SubmitReviewMessage`, `SavePendingQueueMessage`

---

# Extension-Side Wiring (`src/markdownEditorProvider.ts`)

## Purpose

Wire comment message handlers into the existing editor provider. The extension is a pass-through: it runs gh CLI commands and forwards results.

## New State (instance fields on MarkdownEditorProvider)

| Field | Type | Lifecycle |
|-------|------|-----------|
| cachedPrInfo | PrInfo or null | Set on first toggle-on; cleared on dispose |
| cachedCurrentUser | string or null | Set on first toggle-on; cleared on dispose |
| cachedLineMapping | LineMapping or null | Set on toggle-on/refresh; cleared on toggle-off/dispose |
| reviewModeActive | boolean | Tracks current toggle state |

## New Message Handlers

Added to the existing `webview.onDidReceiveMessage` callback:

### commentToggle (enabled: true)

1. **Dirty check**: Run `git diff HEAD -- <filepath>` and `git log @{u}..HEAD -- <filepath>` via `child_process.execFile("git", ...)`. If either produces non-empty stdout, send `CommentErrorMessage` with the dirty file message and return.
2. **gh availability**: Call `isGhAvailable(cwd)`. If false, send `CommentErrorMessage` with install link and return.
3. **gh authentication**: Call `isGhAuthenticated(cwd)`. If false, send `CommentErrorMessage` with auth message and return.
4. **PR detection**: If `cachedPrInfo` is null, call `detectPr(cwd)`. If null, send `CommentErrorMessage` with "No open PR" and return. Cache the result.
5. **Parallel fetch**: Run these three in parallel (Promise.all):
   - `fetchDiff(pr, cwd)` → then `parseDiffForFile(diffOutput, repoRelativePath)` → store as `cachedLineMapping`
   - `fetchComments(pr, filePath, lineMapping, currentUser, cwd)` → produces threads
   - If `cachedCurrentUser` is null: `fetchCurrentUser(cwd)` → cache result
6. **File-not-in-diff check**: If `lineMapping.addedLines` is empty, send `CommentErrorMessage` with "File not in diff" and return.
7. **Build and send** `CommentDataMessage` with threads, diffHighlightLines (from lineMapping.addedLines mapped to lineNumber), prNumber, prUrl, currentUser, lastFetchedAt.
8. **Send persisted pending queue**: Read `workspaceState.get("pendingComments")`, send `SavedPendingQueueMessage` if non-empty.
9. Set `reviewModeActive = true`.

**Note on step 5 ordering**: The `fetchComments` call needs `lineMapping` and `currentUser` which are produced by the other parallel calls. Resolve this by running `fetchDiff` + `fetchCurrentUser` in parallel first, then calling `fetchComments` with their results. Alternatively, pass `lineMapping` and `currentUser` resolution into `fetchComments` and let it await them internally.

Practical ordering:
- Phase A (parallel): `fetchDiff` + `fetchCurrentUser`
- Phase B (after A): `parseDiffForFile` (sync, from fetchDiff result), then `fetchComments` (needs lineMapping + currentUser)

### commentToggle (enabled: false)

1. Clear `cachedLineMapping`
2. Set `reviewModeActive = false`
3. No message needed — webview handles its own cleanup

### commentRefresh

1. Run `fetchDiff` + `fetchComments` in parallel (reuse `cachedPrInfo` and `cachedCurrentUser`)
2. Update `cachedLineMapping`
3. Send updated `CommentDataMessage`

### commentOpenPr

1. Call `openPrInBrowser(cwd)`

### validateLine

1. Look up the line(s) in `cachedLineMapping` using `validateMultiLineMapping`
2. Send `LineMappingResultMessage` with the result

### submitReview

1. Split `pending` into `newComments` (threadId is null) and `replies` (threadId is not null)
2. Re-fetch latest commit SHA: `getLatestCommitSha(pr, cwd)`
3. Re-fetch diff and rebuild line mapping (fresh validation)
4. Re-validate all `newComments` against the fresh mapping. If any are now unmappable, include them in the error
5. Call `submitReviewBatch(pr, newComments, replies, commitSha, cwd)`
6. Send `ReviewSubmitResultMessage` with the result
7. On success, auto-trigger a refresh (re-fetch comments + diff, send updated `CommentDataMessage`)

### savePendingQueue

1. Write `pending` to `context.workspaceState.update("pendingComments", pending)`

## Repo-Relative Path Calculation

The document URI is absolute. To get the repo-relative path for `gh` API calls:

1. Get the workspace folder for the document: `vscode.workspace.getWorkspaceFolder(document.uri)`
2. Compute the relative path: `vscode.workspace.asRelativePath(document.uri, false)`
3. This gives the path from the workspace root (which should be the repo root)

## Error Handling in Message Handlers

All gh CLI calls are wrapped in try/catch. Errors are classified and sent to the webview:

1. Catch `GhNotFoundError` → send `CommentErrorMessage` with install link
2. Catch `GhAuthError` → send `CommentErrorMessage` with auth message
3. Catch `GhApiError` → call `classifyGhError(error)`:
   - `"token-expired"` → send `CommentErrorMessage` with re-auth message
   - `"permission-denied"` or `"pr-closed"` → send `CommentErrorMessage` with terminal message
   - `"stale-sha"`, `"rate-limited"`, `"unknown"` → send `ReviewSubmitResultMessage` with `success: false`
4. Log full error details (including stderr) to the "LiveMarkdown" output channel
5. Sanitise error messages before sending to webview: strip file paths and tokens from gh stderr

---

# Pending Comment Store (`src/webview/pendingCommentStore.ts`)

## Purpose

In-memory queue of pending comments with change notification and persistence bridge.

## Constructor

- **Input**: `vscode` (VsCodeApi — the webview's postMessage handle)
- Stores the vscode reference for persistence calls

## Methods

### add

- **Input**: `comment` (PendingComment)
- **Behaviour**: Push to internal array, notify listeners, persist.

### remove

- **Input**: `tempId` (string)
- **Behaviour**: Remove the matching entry, notify listeners, persist.

### get

- **Input**: `tempId` (string)
- **Output**: PendingComment or undefined

### getAll

- **Output**: PendingComment[] (shallow copy)

### getCount

- **Output**: number

### clear

- **Behaviour**: Empty the array, notify listeners, persist (sends empty array).

### clearSuccessful

- **Input**: `failedIds` (string[])
- **Behaviour**: Keep only entries whose `tempId` is in `failedIds`. Remove everything else. Notify listeners, persist.

### hydrate

- **Input**: `pending` (PendingComment[])
- **Behaviour**: Replace internal array with the provided data. Notify listeners. Do NOT persist (this is the load path — persisting would be redundant).

### onChange

- **Input**: `listener` (() => void)
- **Output**: unsubscribe function (() => void)
- **Behaviour**: Add listener to the set. Return a function that removes it.

## Persistence Bridge

Every mutating method (except `hydrate`) calls a private `persist()` method that sends a `SavePendingQueueMessage` to the extension via `vscode.postMessage({ type: "savePendingQueue", pending: this.getAll() })`.

---

# Comment Indicator Plugin (`src/webview/commentIndicator.ts`)

## Purpose

ProseMirror plugin that manages decorations for diff highlighting, comment indicators, the "+" hover button, and the text selection comment button.

## Plugin State

The plugin stores:

| Field | Type | Description |
|-------|------|-------------|
| reviewMode | boolean | Whether review mode is active |
| diffHighlightLines | Set<number> | Working-copy line numbers to highlight green |
| threads | CommentThread[] | Current file's comment threads |
| pendingComments | PendingComment[] | Current pending queue |

State is updated via a custom transaction metadata key (e.g., `commentIndicatorUpdate`). When a `commentData` message arrives or the pending queue changes, the webview dispatches a transaction with the new state.

## Decoration Types

### Diff highlight decorations

- **Applied to**: Block nodes (paragraphs, headings, list items, code blocks, table rows) whose 1-based block index is in `diffHighlightLines`
- **CSS class**: `diff-highlight`
- **Type**: Node decoration on the block node
- **Visibility**: Only when `reviewMode === true`

### Comment highlight decorations

- **Applied to**: Block nodes at lines matching any `CommentThread.workingCopyLine` (or within `workingCopyStartLine..workingCopyLine` for multi-line threads)
- **CSS class**: `comment-highlight`; for pending comments: `comment-highlight-pending`
- **Type**: Node decoration layered on top of diff highlight

### Comment count badge (widget decoration)

- **Position**: After the block node at each commented line
- **Content**: A `<span>` element with class `comment-badge`
- **Text**: Thread comment count (e.g., "3"). Pending-only lines show "+1"
- **Click handler**: Emits a custom DOM event `comment-badge-click` with the line number, which `commentPanel.ts` listens to

### "+" hover button

- **Applied to**: All diff-highlighted block nodes (every line in `diffHighlightLines`)
- **Implementation**: A CSS pseudo-element (`::after`) on `.diff-highlight` blocks, positioned at the right edge. Visible on `:hover` only. The pseudo-element approach avoids creating widget decorations for every highlighted line.
- **Click handler**: The actual click target is a thin invisible widget decoration at the right edge of each diff-highlighted line. On click, emits `comment-new-click` event with the line number.

### Text selection comment button

- **Not a ProseMirror decoration** — this is a separate floating DOM element.
- **Behaviour**:
  1. Listen to `selectionchange` events on the document
  2. When the TipTap editor has a non-empty text selection and `reviewMode === true`:
     - Determine the block nodes spanned by the selection
     - Check if ALL spanned blocks are within `diffHighlightLines`
     - If yes: show a floating button positioned at the right edge of the selection's bounding rect
     - If any spanned block is NOT in `diffHighlightLines`: do not show the button
  3. On click: emit `comment-new-click` with `{ line: endLine, startLine: startLine }` (both 1-based block indices)
  4. Hide the button when selection clears or changes to a non-highlighted area

## Block Index to Line Number Mapping

TipTap's document is a flat list of block nodes. The 1-based index of each top-level block node corresponds approximately to the markdown line number. The mapping algorithm:

1. Walk `editor.state.doc.content` — iterate over top-level child nodes
2. For each node, record its index (1-based) as the "markdown line number"
3. Build a map: block index → ProseMirror position range (from, to)
4. This map is used to:
   - Apply decorations at the correct positions
   - Resolve which line a user clicked on
   - Anchor the comment panel to the correct DOM element

**Known limitation**: Complex structures (tables, nested lists, code blocks) may span multiple markdown lines but appear as a single block node. The index will be off for subsequent blocks. This is the line-mapping approximation documented in the HLD.

---

# Comment Panel (`src/webview/commentPanel.ts`)

## Purpose

Floating right-margin panel for viewing and creating comments on a specific line.

## Construction

- **Input**: An `HTMLElement` container (appended to the editor's parent), a reference to `PendingCommentStore`, and a `postMessage` function for validation requests.

## Panel Lifecycle

### open (existing thread)

- **Input**: `thread` (CommentThread), `anchorElement` (HTMLElement — the block node's DOM element)
- **Behaviour**:
  1. Close any currently open panel
  2. Create the panel DOM structure (see layout below)
  3. Position the panel in the right margin, vertically aligned with `anchorElement`
  4. Populate with the thread's comments and any pending comments for this line
  5. Register close handlers (Escape, click-outside, close button)

### open (new comment)

- **Input**: `line` (number), `startLine` (number or null), `anchorElement` (HTMLElement)
- **Behaviour**:
  1. Close any currently open panel
  2. Create the panel DOM structure with "New comment on line N" header (or "lines N-M" for multi-line)
  3. No existing comments — just the textarea and Queue button
  4. Position and register handlers as above

### close

- **Behaviour**: Remove the panel DOM element, clear event listeners.

### refresh

- **Input**: Updated `threads` and `pendingComments`
- **Behaviour**: If the panel is open, re-render its contents with fresh data. Preserve any text in the reply textarea.

## Panel DOM Layout

```
div.comment-panel (absolutely positioned)
  div.comment-panel-header
    span.comment-panel-line ("Line 42" or "Lines 42-48")
    span.comment-panel-count ("3 comments")
    button.comment-panel-close ("×")
  div.comment-panel-body (max-height: 300px, overflow-y: auto)
    [For each comment in thread]:
      div.comment-entry (or .comment-entry-outdated, or .comment-entry-pending)
        div.comment-meta
          span.comment-author ("@alice")
          span.comment-timestamp ("2h ago")
          [if outdated]: span.comment-outdated-label ("Outdated")
          [if pending]: button.comment-discard ("×")
          [if pending]: span.comment-pending-label ("Pending")
        div.comment-body
          [raw text, preserving whitespace]
  div.comment-panel-reply (outside scroll area)
    textarea.comment-reply-input (placeholder: "Type a reply...")
    button.comment-reply-queue ("Queue")
```

## Positioning Algorithm

1. Get `anchorElement.getBoundingClientRect()`
2. Set panel `top` to `anchorRect.top + window.scrollY`
3. Set panel `left` to `editorElement.getBoundingClientRect().right + 16px` (16px gap)
4. If the panel would extend below the viewport, shift it upward
5. Reposition on scroll: attach a scroll listener that recalculates `top` based on the anchor's current position
6. Use `requestAnimationFrame` throttling for the scroll listener (same pattern as the existing scroll anchor)

## Queue Button Behaviour

1. Read textarea value (raw text, no transformation)
2. Generate a `tempId` via `crypto.randomUUID()`
3. Determine `workingCopyLine` and `workingCopyStartLine` from the panel context
4. Send `ValidateLineMessage` to the extension with the tempId and line(s)
5. Wait for `LineMappingResultMessage`:
   - If `diffLine` is not null: create a `PendingComment` and add to `PendingCommentStore`
   - If `diffLine` is null: show inline error below the textarea, disable the Queue button
6. Clear the textarea on success

For replies to existing threads, the `threadId` is set to the thread's root comment ID. For new comments, `threadId` is null.

## Close Behaviour

- Close button click: call `close()`
- Escape key: listen for `keydown` on the document, call `close()` if Escape and panel is open. Do not close if the textarea has focus and text — only close on Escape when textarea is empty or not focused.
- Click outside: listen for `mousedown` on the document. If the target is outside the panel element, call `close()`. Use a one-frame delay (`requestAnimationFrame`) to avoid closing immediately when clicking the badge that opens the panel.

## Discard Button Behaviour

1. Get the `tempId` from the pending comment's data attribute
2. Call `pendingCommentStore.remove(tempId)`
3. Re-render the panel (the onChange listener handles this)

---

# Comment Toggle (`src/webview/commentToggle.ts`)

## Purpose

Toolbar buttons: Review toggle, Refresh, Submit Review, and staleness indicator.

## Construction

- **Input**: `editor` (TipTap Editor), `vscode` (VsCodeApi), `pendingCommentStore` (PendingCommentStore)
- Creates and appends toolbar buttons to `document.body` (same pattern as existing wrap/copy toggles in `index.ts`)

## DOM Elements

### Review toggle button

- Class: `review-toggle`
- Default text: `"Review"`
- Active text: `"Review: ON  PR #123"` (number from CommentDataMessage)
- The "PR #123" portion is a nested `<span class="review-pr-badge">` with its own click handler
- On click (toggle OFF → ON): send `CommentToggleMessage { enabled: true }`, add loading state class
- On click (toggle ON → OFF): send `CommentToggleMessage { enabled: false }`, set editor `editable: true`, clear all comment UI state
- On receiving `CommentDataMessage`: update text, remove loading class, set editor `editable: false`
- On receiving `CommentErrorMessage`: remove loading class, show error as tooltip for 5 seconds, toggle stays OFF
- PR badge click: send `CommentOpenPrMessage`

### Refresh button

- Class: `review-refresh`
- Text: `"Refresh"`
- Visibility: only when review mode is ON
- On click: send `CommentRefreshMessage`, add loading class
- On receiving `CommentDataMessage`: remove loading class

### Submit Review button

- Class: `review-submit`
- Text: `"Submit Review (N)"` where N is `pendingCommentStore.getCount()`
- Visibility: only when review mode is ON AND `getCount() > 0`
- Subscribe to `pendingCommentStore.onChange` to update count and visibility
- On click: show confirmation (see below), then send `SubmitReviewMessage`
- State transitions: idle → confirming → loading → success/error

### Staleness indicator

- Class: `review-staleness`
- Text: `"Last refreshed N min ago"` or `"Last refreshed just now"`
- Visibility: only when review mode is ON
- Stores `lastFetchedAt` from `CommentDataMessage`
- Updates every 60 seconds via `setInterval`

## Confirmation Flow

1. User clicks "Submit Review (N)"
2. Replace button text with "Submit N comments to PR #123?" and show Confirm/Cancel buttons
3. On Confirm: disable button (double-submit prevention), show spinner, send `SubmitReviewMessage`
4. On Cancel: revert to idle state
5. On receiving `ReviewSubmitResultMessage`:
   - Success: show green checkmark, auto-revert to idle after 2 seconds
   - Partial failure: show orange warning, button re-enabled
   - Full failure: show red error icon + tooltip with error message, button re-enabled

## Staleness TTL

- Store `lastFetchedAt` (number, from `CommentDataMessage`)
- Every 60 seconds, recalculate the display text
- Display rules:
  - `< 60s`: "Last refreshed just now"
  - `1-59 min`: "Last refreshed N min ago"
  - `>= 60 min`: auto-clear comment data, show "Comments expired — toggle review to refresh"
- The 1-hour TTL fires from the staleness timer. When it fires:
  1. Clear threads and diff highlights from the comment indicator plugin
  2. Show the expiry message
  3. Leave review mode ON but with no data displayed

## Cleanup

When review mode is toggled OFF:

1. Clear staleness interval
2. Hide Refresh, Submit Review, staleness indicator
3. Reset toggle button text to "Review"
4. Set editor `editable: true`

---

# Webview Initialisation (`src/webview/index.ts`)

## Changes

After the existing editor, syncClient, wrap toggle, and copy toggle initialisation:

1. Create `PendingCommentStore` instance, passing `vscode`
2. Create `CommentToggle` instance, passing `editor`, `vscode`, `pendingCommentStore`
3. Create `CommentPanel` instance, passing a container element, `pendingCommentStore`, and `vscode.postMessage`
4. Register the comment indicator ProseMirror plugin on the editor (via `editor.registerPlugin`)
5. Add message handler in the existing `window.addEventListener('message', ...)` callback:
   - `commentData`: forward to comment toggle, comment indicator plugin (update decorations), and comment panel (refresh if open)
   - `reviewSubmitResult`: forward to comment toggle (update button state), pending store (`clear` or `clearSuccessful`)
   - `commentError`: forward to comment toggle (show error)
   - `lineMappingResult`: forward to comment panel (resolve pending validation)
   - `savedPendingQueue`: forward to pending store (`hydrate`)
6. Wire DOM events:
   - `comment-badge-click` → open comment panel for that thread
   - `comment-new-click` → open new-comment panel for that line

---

# Workspace State Format

## Key

`"pendingComments"` — stored on `context.workspaceState`

## Value

JSON-serialisable array of `PendingComment` objects. Example:

```
[
  {
    "tempId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "threadId": null,
    "body": "Fix this typo",
    "workingCopyLine": 15,
    "workingCopyStartLine": null,
    "diffLine": 8,
    "diffStartLine": null
  },
  {
    "tempId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "threadId": 456,
    "body": "Agreed, will fix",
    "workingCopyLine": 42,
    "workingCopyStartLine": null,
    "diffLine": null,
    "diffStartLine": null
  }
]
```

The value is the full pending queue. On every mutation, the entire array is overwritten (not patched). Pending comments with `diffLine: null` are preserved — they'll be re-validated on the next submit attempt.

---

# CSS Design Tokens

All comment UI uses VS Code theme variables for light/dark/high-contrast support.

| Element | Variable | Notes |
|---------|----------|-------|
| Panel background | `--vscode-editorWidget-background` | |
| Panel border | `--vscode-editorWidget-border` | |
| Panel shadow | `0 2px 8px rgba(0, 0, 0, 0.3)` | Fixed, works for both themes |
| Author text | `--vscode-editor-foreground` | |
| Timestamp | `--vscode-descriptionForeground` | |
| Comment body | `--vscode-editor-foreground` | Monospace, preserve whitespace |
| Diff highlight | `--vscode-diffEditor-insertedTextBackground` | At 0.2 opacity |
| Comment line highlight | `--vscode-editor-findMatchHighlightBackground` | At 0.15 opacity |
| Pending border | `--vscode-editorInfo-foreground` | 1px dashed |
| Badge background | `--vscode-badge-background` | |
| Badge foreground | `--vscode-badge-foreground` | |
| "+" button background | `--vscode-button-secondaryBackground` | |
| "+" button foreground | `--vscode-button-secondaryForeground` | |
| Success icon | `--vscode-testing-iconPassed` | |
| Error icon | `--vscode-testing-iconFailed` | |
| Loading spinner | `--vscode-progressBar-background` | |
| Submit button bg | `--vscode-button-background` | |
| Submit button fg | `--vscode-button-foreground` | |
| Reply textarea bg | `--vscode-input-background` | |
| Reply textarea border | `--vscode-input-border` | |
| Reply textarea fg | `--vscode-input-foreground` | |
| Outdated label | `--vscode-descriptionForeground` | At 0.6 opacity |
| Outdated comment bg | `rgba(128, 128, 128, 0.05)` | Fixed, subtle |
| Staleness text | `--vscode-descriptionForeground` | |

---

# Error Handling

## Error Classification Table

| Trigger | Detection | Category | User Message | Display |
|---------|-----------|----------|-------------|---------|
| gh not installed | execFile ENOENT | Terminal | "GitHub CLI (gh) is not installed. Install it from https://cli.github.com to use PR comments." | VS Code notification |
| Not authenticated | `gh auth status` non-zero | Terminal | "GitHub CLI is not authenticated. Run `gh auth login` in your terminal." | VS Code notification |
| Token expired mid-session | 401/403 + "Bad credentials" or "token expired" in stderr | Recoverable | "Your GitHub authentication has expired. Run `gh auth login` to re-authenticate, then Refresh." | CommentError in webview |
| No open PR | `gh pr view` non-zero exit | Terminal | "No open PR found for this branch." | CommentError, tooltip on toggle |
| PR closed/merged | `gh pr view --json state` = CLOSED/MERGED | Terminal | "PR #{number} is closed." | CommentError, tooltip on toggle |
| Not a git repo | `gh pr view` fails + "not a git repository" | Terminal | "This file is not in a git repository." | CommentError, tooltip on toggle |
| Dirty file (uncommitted) | `git diff HEAD -- <file>` produces output | Terminal | "This file has local changes that haven't been pushed. Commit and push your changes before enabling review mode." | CommentError, tooltip on toggle |
| Dirty file (unpushed) | `git log @{u}..HEAD -- <file>` produces output | Terminal | Same as above | CommentError, tooltip on toggle |
| File not in diff | parseDiffForFile returns empty addedLines | Terminal | "This file has no changes in PR #{number}." | CommentError, tooltip on toggle |
| Line unmappable | validateLineMapping returns null | Terminal (this comment) | "This line is not part of the PR diff. Only lines added or modified in the PR can receive comments." | Inline error in panel |
| Stale commit SHA | 422 + "commit_id is not part of the pull request" | Recoverable | "The PR has new commits. Refreshing..." | Auto-refresh + retry |
| Network timeout | gh CLI timeout | Recoverable | "Network error. Check your connection and try again." | ReviewSubmitResult error |
| Rate limited | 403 + "rate limit" | Recoverable | "Rate limit exceeded. Resets in N minutes." (extract reset time from headers if available) | ReviewSubmitResult error |
| Permission denied | 403 + "Resource not accessible" or "Must have write access" | Terminal | "You don't have write access to this repository. Comment on GitHub directly." | ReviewSubmitResult error |
| PR closed mid-submit | 422 + "pull request is closed" | Terminal | "PR #{number} was closed. Comments were not posted." | ReviewSubmitResult error |
| JSON parse failure | gh stdout fails to parse | Recoverable | "Unexpected response from GitHub CLI. Check with `gh --version` and update if needed." | CommentError |
| Diff fetch failure | gh pr diff non-zero exit | Degraded mode | "Diff unavailable — comment positions may be inaccurate. New comments disabled." | Persistent banner in webview |

## Error Display Strategy

- **VS Code notification**: Used for blockers detected during toggle (gh missing, auth missing). These use `vscode.window.showErrorMessage` on the extension side.
- **CommentError to webview**: Used for toggle-time errors that need to display in the webview (tooltip on toggle button). Sent as `CommentErrorMessage`.
- **ReviewSubmitResult error**: Used for post-time errors. The webview handles display via the submit button's error state.
- **Inline panel error**: Used for line mapping failures. Shown below the textarea in the comment panel.

## Error Message Sanitisation

Before including gh stderr in user-facing messages:

1. Strip absolute file paths (replace with relative or remove)
2. Strip tokens (replace anything matching `gho_*` or `ghp_*` patterns with `[token]`)
3. Trim to first 200 characters
4. Log the full unsanitised stderr to the "LiveMarkdown" output channel

---

# Degraded Mode

When `gh pr diff` fails but comment fetching succeeds:

1. Set `lineMapping` to an empty mapping (no highlight lines, no new comments possible)
2. Map existing comments using `original_line` from the API response as an approximate working-copy line
3. Prefix approximate positions visually: the comment panel header shows "~Line 42" instead of "Line 42"
4. Disable the "+" hover button and text selection comment button (no `diffHighlightLines` to display)
5. Allow replies to existing threads (replies use `in_reply_to` and don't need line mapping)
6. Show a persistent banner at the top of the editor: "Diff unavailable — comment positions may be inaccurate. New comments disabled."

---

# Data Flow Examples

## GitHub REST API Response Shape (Review Comments)

Each item in the paginated array from `GET /repos/{owner}/{repo}/pulls/{number}/comments`:

| Field | Type | Used for |
|-------|------|----------|
| id | number | Thread root ID, `in_reply_to` target |
| user.login | string | Author, isOwn check |
| body | string | Comment text |
| created_at | string | Timestamp |
| path | string | File filtering |
| line | number or null | Current diff position (null = outdated) |
| original_line | number | Original diff position (fallback for degraded mode) |
| start_line | number or null | Multi-line range start (null = single line) |
| in_reply_to_id | number or null | Thread grouping (null = root comment) |
| side | string | Always "RIGHT" for new-side comments |

## CommentDataMessage Example

```
{
  type: "commentData",
  prNumber: 123,
  prUrl: "https://github.com/user/repo/pull/123",
  currentUser: "abhishek",
  threads: [
    {
      id: 1001,
      path: "src/utils/parser.md",
      diffLine: 8,
      diffStartLine: null,
      workingCopyLine: 15,
      workingCopyStartLine: null,
      comments: [
        { id: 1001, author: "reviewer1", body: "Fix this typo", createdAt: "2026-03-20T10:00:00Z", isOwn: false, isOutdated: false },
        { id: 1002, author: "abhishek", body: "Done", createdAt: "2026-03-20T11:00:00Z", isOwn: true, isOutdated: false }
      ]
    },
    {
      id: 1003,
      path: "src/utils/parser.md",
      diffLine: 22,
      diffStartLine: 18,
      workingCopyLine: 28,
      workingCopyStartLine: 24,
      comments: [
        { id: 1003, author: "reviewer2", body: "This section needs rewriting", createdAt: "2026-03-20T09:00:00Z", isOwn: false, isOutdated: true }
      ]
    }
  ],
  diffHighlightLines: [12, 13, 14, 15, 16, 24, 25, 26, 27, 28, 35],
  lastFetchedAt: 1711000000000
}
```

## Diff Output Example

```
diff --git a/src/utils/parser.md b/src/utils/parser.md
index abc1234..def5678 100644
--- a/src/utils/parser.md
+++ b/src/utils/parser.md
@@ -10,6 +10,11 @@
 context line (line 10 in old, line 10 in new)
 context line (line 11 in old, line 11 in new)
 context line (line 12 in old, line 12 in new)
+added line (line 13 in new — diffPosition 4)
+added line (line 14 in new — diffPosition 5)
+added line (line 15 in new — diffPosition 6)
+added line (line 16 in new — diffPosition 7)
+added line (line 17 in new — diffPosition 8)
 context line (line 13 in old, line 18 in new)
```

From this hunk (`@@ -10,6 +10,11 @@`):
- diffPosition 1-3: context lines → workingCopy 10-12 (not in addedLines)
- diffPosition 4-8: added lines → workingCopy 13-17 (in addedLines)
- diffPosition 9: context line → workingCopy 18 (not in addedLines)

---

# Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `src/sync/commentTypes.ts` | New | Shared type definitions (PrInfo, CommentData, CommentThread, PendingComment, DiffLineInfo, LineMapping) |
| `src/sync/syncProtocol.ts` | Modify | Add 11 new message interfaces and update both union types |
| `src/gh/ghCli.ts` | New | gh CLI wrapper: execGh, isGhAvailable, isGhAuthenticated, classifyGhError, error classes |
| `src/gh/prDetector.ts` | New | detectPr, getRepoInfo, openPrInBrowser |
| `src/gh/commentFetcher.ts` | New | fetchComments (with thread grouping + outdated detection), fetchCurrentUser |
| `src/gh/commentPoster.ts` | New | submitReviewBatch (stubbed initially), getLatestCommitSha |
| `src/gh/diffLineMapper.ts` | New | fetchDiff, parseDiffForFile, validateLineMapping, validateMultiLineMapping |
| `src/markdownEditorProvider.ts` | Modify | Add comment message handlers, dirty-file check, cached state fields, workspace state persistence |
| `src/webview/pendingCommentStore.ts` | New | PendingCommentStore class with persistence bridge |
| `src/webview/commentIndicator.ts` | New | ProseMirror plugin: diff highlights, comment badges, "+" hover button, selection comment button |
| `src/webview/commentPanel.ts` | New | Floating right-margin panel: thread display, reply input, Queue button, positioning |
| `src/webview/commentToggle.ts` | New | Toolbar: Review toggle, Refresh, Submit Review, staleness indicator, confirmation flow |
| `src/webview/index.ts` | Modify | Initialise comment components, wire message routing, register plugin, wire DOM events |
| `src/webview/styles.css` | Modify | Add styles for all comment UI elements using VS Code theme variables |
