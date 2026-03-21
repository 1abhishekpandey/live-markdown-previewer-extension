PR Comments - Technical Design

# New Files

```
src/
  gh/
    ghCli.ts              — gh CLI wrapper (execFile, error handling, availability check)
    prDetector.ts         — detect open PR for current branch
    commentFetcher.ts     — fetch review comments, group into threads
    commentPoster.ts      — batch review submission + reply posting
    diffLineMapper.ts     — parse diff hunks, map diff lines <-> working-copy lines
  sync/
    syncProtocol.ts       — (existing) add new comment message types
    commentTypes.ts       — shared type definitions for comments, threads, PR info
  webview/
    commentPanel.ts       — right-margin comment panel UI (render, scroll, open/close)
    commentIndicator.ts   — ProseMirror plugin for diff highlighting, comment indicators, "+" hover button
    commentToggle.ts      — Review toggle + Submit Review button + Refresh + staleness indicator
    pendingCommentStore.ts — local queue for pending comments before batch submission
```

# Shared Types - commentTypes.ts

```typescript
interface PrInfo {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  owner: string;
  repo: string;
}

interface CommentData {
  id: number;
  author: string;
  body: string;                   // raw text, preserved as-is
  createdAt: string;              // ISO timestamp
  isOwn: boolean;                 // true if posted by the current gh user
  isOutdated: boolean;            // true if the underlying code changed since the comment
}

interface CommentThread {
  id: number;                     // root comment ID
  path: string;                   // file path (repo-relative)
  diffLine: number;               // end line in the diff (right side)
  diffStartLine: number | null;   // start line for multi-line ranges (null = single line)
  workingCopyLine: number;        // mapped end line in the current file
  workingCopyStartLine: number | null; // mapped start line for multi-line ranges (null = single line)
  comments: CommentData[];        // ordered by created_at
}

interface PendingComment {
  tempId: string;                 // client-generated UUID
  threadId: number | null;        // null = new comment, number = reply to thread
  body: string;                   // raw text, preserved exactly
  workingCopyLine: number;        // end line in the current file
  workingCopyStartLine: number | null; // start line for multi-line selections (null = single line)
  diffLine: number | null;        // mapped diff end line (null if mapping failed)
  diffStartLine: number | null;   // mapped diff start line for multi-line ranges (null = single line)
}
```

# Extension Side (Node.js)

## ghCli.ts - gh CLI wrapper

```typescript
class GhNotFoundError extends Error {}
class GhAuthError extends Error {}
class GhApiError extends Error {
  constructor(message: string, public stderr: string, public exitCode: number) {}
}

async function execGh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
// - Uses child_process.execFile('gh', args, { cwd })
// - Throws GhNotFoundError if ENOENT
// - Throws GhApiError on non-zero exit with stderr details

async function isGhAvailable(cwd: string): Promise<boolean>
// - Runs `gh --version`
// - Returns false if not found

async function isGhAuthenticated(cwd: string): Promise<boolean>
// - Runs `gh auth status`
// - Returns false if not authenticated
```

## prDetector.ts - PR detection

```typescript
async function detectPr(cwd: string): Promise<PrInfo | null>
// - Runs: gh pr view --json number,url,headRefName,baseRefName
// - Parses JSON output
// - Returns null if no open PR (gh exits non-zero)
// - If multiple PRs exist for the branch, gh returns the most recent one

async function getRepoInfo(cwd: string): Promise<{ owner: string; repo: string }>
// - Runs: gh repo view --json owner,name
// - Extracts owner and repo name

async function openPrInBrowser(cwd: string): Promise<void>
// - Runs: gh pr view --web
// - Opens the PR page in the default browser
```

## commentFetcher.ts - fetch and structure comments

```typescript
async function fetchComments(pr: PrInfo, filePath: string, cwd: string): Promise<CommentThread[]>
// - Runs: gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
// - Fetches ALL PR comments (not filtered by file in the API call)
// - Filters client-side by path === filePath (repo-relative)
// - Discards comments for other files (not kept in memory)
// - Groups by in_reply_to_id into threads
// - Sorts comments within each thread by created_at
// - Sorts threads by line number
// - Maps diff lines to working-copy lines via diffLineMapper
// - Detects outdated comments: if `line` is null and `original_line` is not null,
//   the code has changed since the comment - mark isOutdated = true
// - Threads whose line cannot be mapped are excluded (comments on deleted lines)

async function fetchCurrentUser(cwd: string): Promise<string>
// - Runs: gh api user --jq '.login'
// - Cached per workspace session (persists across Refresh)
```

## commentPoster.ts - batch review submission

```typescript
interface BatchSubmitResult {
  success: boolean;
  error?: string;
  postedComments?: CommentData[];  // newly created comments
}

async function submitReviewBatch(
  pr: PrInfo,
  newComments: PendingComment[],   // comments on new lines (not replies)
  replies: PendingComment[],        // replies to existing threads
  cwd: string
): Promise<BatchSubmitResult>
// Split into two operations:
//
// 1. New comments -> GitHub Review API (batch):
//    POST /repos/{owner}/{repo}/pulls/{number}/reviews
//    { event: "COMMENT", comments: [{ path, line, start_line?, side: "RIGHT", start_side?, body }] }
//    For multi-line comments, include start_line and start_side.
//    This posts all new-line comments as a single review notification.
//
// 2. Replies -> individual API calls:
//    POST /repos/{owner}/{repo}/pulls/{number}/comments
//    { body, in_reply_to: threadRootId }
//    GitHub's review API doesn't support in_reply_to in the comments array,
//    so replies must be posted individually after the batch.
//
// If step 1 succeeds but step 2 partially fails:
//   - Return partial success with details of which replies failed
//   - Keep failed replies in the pending queue

async function getLatestCommitSha(pr: PrInfo, cwd: string): Promise<string>
// - Runs: gh api repos/{owner}/{repo}/pulls/{number} --jq '.head.sha'
// - Needed for the review API's commit_id field
```

## diffLineMapper.ts - diff parsing and line translation

```typescript
interface DiffLineInfo {
  lineNumber: number;             // working-copy line number
  type: 'added' | 'modified';    // line change type
}

interface LineMapping {
  diffLineToWorkingCopy: Map<number, number>;
  workingCopyToDiffLine: Map<number, number>;
  addedLines: DiffLineInfo[];     // lines with green highlighting (added/modified only)
}

function parseDiffForFile(diffOutput: string, filePath: string): LineMapping
// - Parses the full diff output, extracts hunks for the given file path
// - Discards diff data for other files
// - Parses @@ -a,b +c,d @@ hunk headers
// - Builds bidirectional line number mapping
// - Only maps RIGHT side lines (additions and context lines)
// - Deleted lines (LEFT only) have no working-copy mapping
// - Populates addedLines with added/modified lines for diff highlighting

async function fetchDiff(pr: PrInfo, cwd: string): Promise<string>
// - Runs: gh pr diff {number}
// - Returns raw unified diff output
// - Re-fetched on every Refresh (not cached across refreshes)

function validateLineMapping(workingCopyLine: number, mapping: LineMapping): number | null
// - Returns the diff line for a working-copy line, or null if unmappable
// - Used before queuing a new comment to validate the target
```

# Sync Protocol Additions

New message types in `syncProtocol.ts`:

```typescript
// Extension -> Webview

interface CommentDataMessage {
  type: 'commentData';
  threads: CommentThread[];       // all threads for the current file
  prNumber: number;
  prUrl: string;
  currentUser: string;
  diffHighlightLines: number[];   // working-copy line numbers to highlight (added/modified lines)
  lastFetchedAt: number;          // Date.now() timestamp of when comments were fetched
}

interface ReviewSubmitResult {
  type: 'reviewSubmitResult';
  success: boolean;
  error?: string;                 // error message on failure
  failedReplyIds?: string[];      // tempIds of replies that failed (partial failure)
}

interface CommentError {
  type: 'commentError';
  message: string;
  details?: string;               // gh CLI stderr or stack trace
}

interface LineMappingResult {
  type: 'lineMappingResult';
  tempId: string;                 // matches the pending comment
  diffLine: number | null;        // end diff line, null = unmappable
  diffStartLine: number | null;   // start diff line for multi-line ranges (null = single line or unmappable)
  error?: string;                 // human-readable reason if null
}

// Webview -> Extension

interface CommentToggleMessage {
  type: 'commentToggle';
  enabled: boolean;
}

interface CommentRefreshMessage {
  type: 'commentRefresh';
}

interface CommentOpenPrMessage {
  type: 'commentOpenPr';
}

interface ValidateLineMessage {
  type: 'validateLine';
  tempId: string;
  workingCopyLine: number;        // end line to validate against the diff
  workingCopyStartLine: number | null; // start line for multi-line selections (null = single line)
}

interface SubmitReviewMessage {
  type: 'submitReview';
  pending: PendingComment[];      // full pending queue
}
```

Update the union types:

```typescript
export type ExtensionToWebviewMessage =
  | InitMessage | ExternalUpdateMessage | ScrollToAnchorMessage
  | CommentDataMessage | ReviewSubmitResult
  | CommentError | LineMappingResult;

export type WebviewToExtensionMessage =
  | ReadyMessage | EditMessage | UndoMessage | RedoMessage | SaveMessage
  | ScrollAnchorUpdateMessage | OpenFileMessage
  | CommentToggleMessage | CommentRefreshMessage | CommentOpenPrMessage
  | ValidateLineMessage | SubmitReviewMessage;
```

# Webview Side (Browser)

## commentToggle.ts - toolbar buttons

```
Two toolbar elements plus a staleness indicator (all in the same row as Copy/Wrap):

1. Review toggle:
   - Creates "Review" button
   - On click: sends commentToggle { enabled } to extension
   - Before enabling: extension runs `git diff HEAD -- <filepath>` and `git log @{u}..HEAD -- <filepath>` to check for
     uncommitted/unpushed changes. If any diff exists, blocks toggle with error message:
     "Uncommitted changes detected. Commit or stash before enabling review mode."
   - On toggle ON: sets TipTap editor to editable: false (read-only mode)
   - On toggle OFF: sets TipTap editor to editable: true (normal editing mode)
   - On receiving commentData: updates to "Review: ON  PR #123"
   - PR badge click: sends commentOpenPr to extension
   - When no PR: shows tooltip "No open PR for this branch"

2. Submit Review button (visible when Review is ON + pending > 0):
   - Shows "Submit Review (N)" with count from pendingCommentStore
   - On click: confirmation prompt -> sends submitReview message
   - Double-submit prevention: button disabled on click until result received
   - Loading/success/error states on the button itself

3. Refresh button (visible when Review is ON):
   - On click: sends commentRefresh to extension

4. Staleness indicator (visible when Review is ON):
   - Shows "Last refreshed N min ago" next to Refresh button
   - Stores timestamp of last fetch (from CommentDataMessage.lastFetchedAt)
   - Updates display periodically (every minute)
   - 1-hour TTL: if cached data is older than 1 hour, auto-clears comment data
     and shows "Comments expired, toggle review mode to refresh"
```

## pendingCommentStore.ts - local pending queue

```typescript
class PendingCommentStore {
  private pending: PendingComment[] = [];
  private listeners: Set<() => void> = new Set();

  add(comment: PendingComment): void
  remove(tempId: string): void        // discard a pending comment
  get(tempId: string): PendingComment | undefined
  getAll(): PendingComment[]
  getCount(): number
  clear(): void                        // after successful submission
  clearSuccessful(failedIds: string[]): void  // partial failure: keep only failed ones

  onChange(listener: () => void): () => void  // subscribe to changes
}
```

## commentIndicator.ts - ProseMirror decoration plugin + diff highlighting

```
ProseMirror plugin that manages three types of decorations:

1. Diff highlight decorations (green background):
   - Applied to block nodes whose markdown line is in the diffHighlightLines array
     (added/modified lines from the PR diff)
   - CSS class: 'diff-highlight' (green background tint)
   - Applied when review mode is toggled ON
   - Removed when review mode is toggled OFF
   - Only added lines — context lines and deleted lines are skipped

2. Comment highlight decorations:
   - Applied to block nodes whose markdown line matches a CommentThread.workingCopyLine
     (or falls within workingCopyStartLine..workingCopyLine for multi-line ranges)
   - CSS class: 'comment-highlight' (subtle background tint, layered over diff highlight)
   - Lines with pending comments get: 'comment-highlight-pending' (dashed border)

3. Widget decorations (comment count badge):
   - Small badge on the right edge of highlighted lines
   - Shows thread comment count (e.g., "3")
   - Pending comments shown with "+" prefix (e.g., "+1")
   - Click handler: dispatches event to open/close the comment panel

4. "+" hover button on diff-highlighted lines:
   - Appears on hover over any diff-highlighted (green) line
   - Click opens the comment panel anchored to that line
   - Only visible when review mode is ON
   - Implementation: CSS hover state on diff-highlighted block nodes with a
     positioned pseudo-element, or a widget decoration that shows/hides on hover

Comment creation affordances:
- "+" hover button on any highlighted (added/modified) line
- Text selection on highlighted lines: a small floating comment button appears on the right side of the selection (similar to Notion's comment affordance)
- Comments can only be added on added/modified lines (diff-highlighted)

Line detection strategy:
- TipTap's doc is a flat list of block nodes (paragraphs, headings, list items, etc.)
- Each block node's index in the document ~ its markdown line number
- Walk the document to build: block index -> DOM element mapping
- Use this mapping to anchor both decorations and the comment panel

Plugin state:
- Stores current threads + pending comments + diff highlight lines
- Rebuilt when commentData message arrives or pending queue changes
- Returns DecorationSet.empty when toggle is OFF
```

## commentPanel.ts - right-margin floating panel

```
Structure:
  +-----------------------------+
  | Line 42 . 3 comments     x |  <- header (line number, count, close button)
  +-----------------------------+
  | +- scrollable ------------+ |  <- max-height: 300px, overflow-y: auto
  | | @user . 2h ago          | |
  | | Fix this typo here      | |
  | |                         | |
  | | @bob . 1h ago Outdated  | |  <- faded "Outdated" label if code changed
  | | Agreed, also check      | |
  | | line 15                 | |
  | | ----------------------- | |  <- pending separator
  | | @you . Pending      [x] | |  <- pending: discard button only (no edit)
  | | I'll fix both           | |
  | +-------------------------+ |
  +-----------------------------+
  | +--------------------+      |  <- reply textarea (always visible, outside scroll)
  | | Type a reply...    |      |
  | +--------------------+      |
  |                     [Queue] |  <- always "Queue" (batch-only, no immediate posting)
  +-----------------------------+

Panel behaviour:
- Only one panel open at a time
- Opening a panel closes any other open panel
- Panel is an absolutely-positioned div in the right margin
- Anchored to the DOM element of the highlighted line
- Repositions on scroll (via scroll listener or IntersectionObserver)
- Close on: close button click, Escape key, clicking outside

New comment panel (from "+" hover button or text selection on highlighted lines):
- Same structure but with "New comment on line N" header
  (or "New comment on lines N-M" for multi-line)
- No existing thread - just the reply textarea
- Button always shows "Queue" -> adds to pendingCommentStore
- Validation: before queuing, sends validateLine to extension
- If line is unmappable: shows error inline, disables Queue button

Text handling:
- Textarea preserves all input exactly (newlines, code, markdown syntax)
- Body is sent as raw string - no transformation or stripping
```

# Message Flow Diagrams

## Toggle ON

```
Webview                          Extension
  |                                 |
  |  commentToggle { enabled: true} |
  | ------------------------------> |
  |                                 |  1. Dirty check: git diff HEAD -- <filepath>
  |                                 |     + git log @{u}..HEAD -- <filepath>
  |                                 |     If dirty: send commentError, abort
  |                                 |  2. isGhAvailable() - if not, send commentError
  |                                 |  3. isGhAuthenticated() - if not, send commentError
  |                                 |  4. detectPr() - if null, send commentError
  |                                 |  5. Parallel calls:
  |                                 |     - fetchComments() for current file
  |                                 |     - fetchDiff() + parseDiffForFile()
  |                                 |     - fetchCurrentUser()
  |  commentData { threads, pr,    |
  |    diffHighlightLines,          |
  |    lastFetchedAt }              |
  | <------------------------------ |
  |                                 |
  |  (set editor to read-only)      |
  |  (render diff highlights,       |
  |   comment indicators,           |
  |   store PR info)                |
```

## Add Comment ("+" hover button or text selection on highlighted lines)

```
Webview                          Extension
  |                                 |
  |  (user clicks "+" on highlighted line, or selects text on highlighted lines)
  |  validateLine { tempId, line,   |
  |    startLine? }                 |
  | ------------------------------> |
  |                                 |  1. Look up workingCopyToDiffLine mapping
  |                                 |     for both start and end lines (if multi-line)
  |  lineMappingResult { diffLine,  |
  |    diffStartLine? }             |
  | <------------------------------ |
  |                                 |
  |  (if diffLine is null: show error, stop)
  |  (if valid: show panel, user types comment)
  |  (user clicks "Queue" -> add to pendingCommentStore)
```

## Submit Review (batch)

```
Webview                          Extension
  |                                 |
  |  submitReview { pending[] }     |
  | ------------------------------> |
  |                                 |  1. Split pending into newComments + replies
  |                                 |  2. Re-fetch commit SHA
  |                                 |  3. Re-validate line mappings
  |                                 |  4. POST reviews API (new comments batch)
  |                                 |     For multi-line: include start_line + start_side
  |                                 |  5. POST individual replies
  |  reviewSubmitResult { success } |
  | <------------------------------ |
  |                                 |
  |  (clear pending, re-fetch)      |
  |  commentRefresh                 |  (auto-triggered after success)
  | ------------------------------> |
```

# Multi-line Comments

- Kept in v1
- Map both `start_line` and `line` through the diff line mapper
- Include `start_side` parameter for multi-line comments (in addition to `side`)
- Fallback: if only one line maps successfully, post as single-line comment

# Review Mode Constraints

- Read-only: when toggle ON, set TipTap editor to `editable: false`
- When toggle OFF, restore `editable: true`
- Dirty file check: before enabling toggle, run `git diff HEAD -- <filepath>` and `git log @{u}..HEAD -- <filepath>`. If any diff output exists, block toggle with error message

# Cache Strategy

- PR info + current user: cached per workspace session (persists across Refresh)
- Comments + diff: re-fetched on every Refresh
- In-memory cache per file while toggle is ON
- Persists across tab switches (not cleared when user switches to another file)
- Clear on: toggle OFF, file close, window close/reload, 1-hour TTL

# Staleness Indicator

- Store timestamp of last fetch (from `CommentDataMessage.lastFetchedAt`)
- Display relative time near Review toggle ("Last refreshed N min ago")
- 1-hour TTL: if cached data is older than 1 hour, auto-clear comment data and show "Comments expired, toggle review mode to refresh"

# Outdated Detection

- Kept in v1
- Heuristic: `line === null && original_line !== null` means the code changed since the comment
- No extra API call needed - uses fields already present in the REST response

# Performance

Parallelise gh CLI calls on toggle-on:

- Sequential: `gh auth status` -> `gh pr view`
- Parallel (after PR detected): `gh api .../comments` + `gh pr diff` + `gh api user`

Cache PR info and current user per workspace session.

# Error Handling

6 categories with recoverable/terminal distinction:

| Error | Detection | Recovery | User-facing response |
|-------|-----------|----------|---------------------|
| gh CLI not installed | `execFile` ENOENT -> GhNotFoundError | Terminal | VS Code notification: "GitHub CLI (gh) not found. Install from https://cli.github.com" |
| gh not authenticated | `gh auth status` non-zero -> GhAuthError | Terminal | VS Code notification: "Not authenticated. Run `gh auth login` in your terminal" |
| Token expiry mid-session | 401/403 with "Bad credentials" in stderr | Recoverable | commentError: "GitHub token expired. Run `gh auth login` to re-authenticate" |
| No open PR | `gh pr view` exits non-zero | Recoverable | commentError -> toggle tooltip: "No open PR for this branch" |
| Dirty file | `git diff HEAD -- <file>` or `git log @{u}..HEAD -- <file>` produces output | Terminal | commentError: "This file has local changes that haven't been pushed. Commit and push your changes before enabling review mode." |
| Line unmappable | validateLineMapping returns null | Recoverable | Inline error in panel: "Cannot map this line to the PR diff" |
| Deleted line comment | diff line has no working-copy mapping | N/A | Thread excluded from display; visible on GitHub |
| Batch submit failed | gh api non-zero exit | Recoverable | reviewSubmitResult { success: false, error } -> error popup, pending preserved |
| Partial reply failure | Some replies fail, batch succeeded | Recoverable | reviewSubmitResult { failedReplyIds } -> clear successful, keep failed |
| Network error | gh CLI timeout or connection refused | Recoverable | commentError -> error popup with details |

Additional error handling:
- Retry re-validates everything (re-fetch commit SHA, re-validate line mapping)
- Double-submit prevention: disable Submit Review button on click until result received

# File Modifications (Existing)

- `syncProtocol.ts` - add comment message types (no immediate/conflict types), add diff highlight lines + lastFetchedAt to CommentDataMessage
- `markdownEditorProvider.ts` - add dirty-file check (`git diff HEAD`), read-only toggle, parallelised gh calls on toggle-on
- `commentTypes.ts` - shared types (no `isResolved` field on CommentThread)
- `commentFetcher.ts` - fetch all PR comments, filter client-side, no `fetchThreadComments()`, no resolved thread GraphQL query
- `commentPoster.ts` - batch review submission only (no immediate posting)
- `pendingCommentStore.ts` - add/remove/get/getAll/getCount/clear/clearSuccessful/onChange (no `update()` method)
- `commentPanel.ts` - right-margin panel with discard button on pending comments (no edit button, no conflict state, no resolved thread styling)
- `commentIndicator.ts` - diff highlighting decorations (green background on added/modified lines), comment indicators, "+" hover button on diff-highlighted lines
- `commentToggle.ts` - Review toggle + Submit Review + Refresh + staleness indicator (no Batch toggle)
- `extension.ts` - no changes needed (toggle lives in webview)
- `index.ts` (webview) - create Review toggle, Submit Review button, initialise comment panel/indicator/pending store
- `styles.css` - add styles for: diff highlights, comment panel, indicator badges, comment line highlights, pending state, "+" hover button, submit button, staleness indicator, loading/success/error states

# CSS Design Tokens

All comment UI uses `--vscode-*` variables for theme integration:

```
Panel background:         --vscode-editorWidget-background
Panel border:             --vscode-editorWidget-border
Panel shadow:             0 2px 8px rgba(0, 0, 0, 0.3)
Author text:              --vscode-editor-foreground
Timestamp:                --vscode-descriptionForeground
Comment body:             --vscode-editor-foreground
Diff highlight (green):   --vscode-diffEditor-insertedTextBackground (at 0.2 opacity)
Comment line highlight:   --vscode-editor-findMatchHighlightBackground (at 0.15 opacity)
Pending border (dashed):  --vscode-editorInfo-foreground
Indicator badge bg:       --vscode-badge-background
Indicator badge fg:       --vscode-badge-foreground
Hover "+" button bg:      --vscode-button-secondaryBackground
Hover "+" button fg:      --vscode-button-secondaryForeground
Success icon:             --vscode-testing-iconPassed
Error icon:               --vscode-testing-iconFailed
Loading spinner:          --vscode-progressBar-background
Submit button bg:         --vscode-button-background
Submit button fg:         --vscode-button-foreground
Reply textarea bg:        --vscode-input-background
Reply textarea border:    --vscode-input-border
Reply textarea fg:        --vscode-input-foreground
Outdated label:           --vscode-descriptionForeground (at 0.6 opacity)
Outdated comment bg:      rgba(128, 128, 128, 0.05)
Staleness text:           --vscode-descriptionForeground
```
