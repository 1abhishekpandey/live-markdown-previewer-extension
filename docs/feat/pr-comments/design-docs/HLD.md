PR Comments Integration - High-Level Design

# Overview

Inline GitHub PR review comments inside the LiveMarkdown WYSIWYG preview. View, reply, and create review comments without leaving VS Code. All GitHub communication goes through the `gh` CLI - no tokens or OAuth in the extension.

# Principles

- **gh CLI as the sole GitHub interface** - no API tokens, no OAuth flows. If `gh` is installed and authenticated, the feature works.
- **Read-only review mode** - editing is disabled while reviewing. This eliminates line-drift problems entirely.
- **Batch-only posting** - all comments are queued locally and submitted as a single GitHub review. One notification per review, not N.
- **Real reads, stubbed writes during development** - all gh read operations are real from day one. Only posting is stubbed until the final phase.
- **Webview owns UI state, extension is a pass-through** - the extension runs gh CLI commands and forwards results. The webview owns the pending queue, panel state, and display logic.
- **Pending queue survives reload** - the pending queue is persisted via VS Code workspace state so queued comments aren't lost on window reload.

# Architecture

## Two-Context Model

The existing extension/webview split is preserved. The extension gains a gh CLI layer; the webview gains comment UI.

```
┌─────────────────────────────┐          ┌──────────────────────────────────┐
│   Extension (Node)          │  msg     │   Webview (Browser)              │
│                             │ ───────► │                                  │
│  markdownEditorProvider     │          │  TipTap Editor (read-only in     │
│  ┌────────────────────┐    │          │    review mode)                  │
│  │ gh CLI layer        │    │ ◄─────── │  Comment UI                      │
│  │  ghCli.ts           │    │          │  ┌─────────────────────────┐     │
│  │  prDetector.ts      │    │          │  │ commentIndicator.ts     │     │
│  │  commentFetcher.ts  │    │          │  │ commentPanel.ts         │     │
│  │  commentPoster.ts   │    │          │  │ commentToggle.ts        │     │
│  │  diffLineMapper.ts  │    │          │  │ pendingCommentStore.ts   │     │
│  └────────────────────┘    │          │  └─────────────────────────┘     │
│  workspaceState (persist)  │          │  syncClient.ts (existing)        │
└─────────────────────────────┘          └──────────────────────────────────┘
```

## State Ownership

| State | Owner | Persistence |
|-------|-------|-------------|
| Pending comment queue | Webview | Persisted via extension's workspaceState (message-based save/load) |
| Comment threads (fetched) | Webview | In-memory, cleared on toggle OFF / 1h TTL |
| Panel open/close, scroll | Webview | Ephemeral |
| PR info (number, url, owner/repo) | Extension | Cached per session |
| Current gh user | Extension | Cached per session |
| Diff line mappings | Extension | Re-built on every fetch/refresh |

## Pending Queue Persistence

The webview can't access VS Code's workspace state directly. A message-based bridge handles durability:

```
Toggle ON / Reload:
  Extension reads workspaceState('pendingComments')
  Extension sends savedPendingQueue { pending[] } to webview
  Webview hydrates its pendingCommentStore

On any pending change (add/discard):
  Webview sends savePendingQueue { pending[] } to extension
  Extension writes to workspaceState('pendingComments')

On successful submit:
  Webview clears store, sends savePendingQueue { [] }
```

This keeps the extension as a dumb persistence layer. The webview remains the single source of truth for the queue at runtime.

# Workflows

## Toggle ON

```
User clicks [Review]
  │
  ▼
Webview ──commentToggle { enabled: true }──► Extension
  │
  ▼ (Extension side, sequential)
  1. Dirty check: git diff HEAD + git log @{u}..HEAD
     └─ If dirty → commentError, abort
  2. gh auth status
     └─ If not authed → commentError, abort
  3. gh pr view --json ...
     └─ If no PR → commentError, abort
  │
  ▼ (Extension side, parallel)
  4a. gh api .../pulls/{n}/comments   (all comments, filter to file)
  4b. gh pr diff {n}                  (full diff, extract file hunks)
  4c. gh api user                     (current user login)
  │
  ▼
Extension ──commentData { threads, diffHighlightLines, ... }──► Webview
Extension ──savedPendingQueue { pending[] }──► Webview (if any persisted)
  │
  ▼
Webview: set editor read-only, render diff highlights + comment indicators
```

## Create Comment (+ button or text selection)

```
User clicks "+" on a highlighted line (or selects text on highlighted lines)
  │
  ▼
Webview opens comment panel anchored to the line
User types comment, clicks [Queue]
  │
  ▼
Webview ──validateLine { tempId, line, startLine? }──► Extension
  │
Extension looks up workingCopyToDiffLine mapping
  │
Extension ──lineMappingResult { diffLine, diffStartLine? }──► Webview
  │
  ▼
If valid: webview adds to pendingCommentStore, sends savePendingQueue
If null: inline error "This line is not part of the PR diff"
```

## Submit Review (batch)

```
User clicks [Submit Review (N)]
  │
  ▼
Confirmation: "Submit N comments to PR #123?"
  │
  ▼ (on confirm)
Webview ──submitReview { pending[] }──► Extension
  │
Extension:
  1. Split pending into new comments + replies
  2. Re-fetch commit SHA (fresh)
  3. Re-validate all line mappings (fresh)
  4. POST /repos/.../pulls/{n}/reviews  (new comments as batch)
  5. POST .../comments with in_reply_to  (replies, individually)
  │
Extension ──reviewSubmitResult { success, failedReplyIds? }──► Webview
  │
  ▼
Success: clear pending, auto-refresh comments
Partial failure: clear successful, keep failed replies pending
Full failure: all pending preserved, error popup
```

## Refresh

```
User clicks [Refresh]
  │
  ▼
Webview ──commentRefresh──► Extension
  │
Extension re-fetches comments + diff (parallel), sends updated commentData
Webview re-renders, staleness indicator resets
```

# Review Mode UI

## Toolbar Layout

```
Review OFF:
  [ Copy: Raw ] [ Wrap: Off ] [ Review ]

Review ON:
  [ Copy: Raw ] [ Wrap: Off ] [ Review: ON  PR #123 ] [ Refresh ] [ Submit Review (3) ]
                                                        ↑
                                              "Last refreshed 5 min ago"
```

- "PR #123" is clickable - opens the PR on GitHub
- Submit Review button only visible when pending count > 0
- Staleness indicator updates every minute; 1-hour TTL auto-clears cached data

## Diff Highlighting

- Added/modified lines get a green background tint (using `--vscode-diffEditor-insertedTextBackground`)
- Context lines and deleted lines are not highlighted
- Only highlighted lines are commentable

## Comment Panel (right margin)

```
+-----------------------------+
| Line 42 . 3 comments     x |  <- header
+-----------------------------+
| +- scrollable (300px) ----+ |
| | @alice . 2h ago          | |
| | Fix this typo            | |
| |                          | |
| | @bob . 1h ago  Outdated  | |  <- faded label
| | Agreed, also line 15     | |
| | ----------------------   | |
| | @you . Pending       [x] | |  <- dashed border, discard only
| | I'll fix both            | |
| +-------------------------+ |
+-----------------------------+
| [ Type a reply...         ] |
|                     [Queue] |
+-----------------------------+
```

- One panel open at a time
- Anchored to the block node, repositions on scroll
- Close via: close button, Escape, click outside
- Pending comments shown with dashed border and "Pending" label
- No edit on pending - discard and re-add
- Posted comments have no edit/delete - do that on GitHub, then Refresh

## Comment Creation Affordances

Two ways to create comments (no keyboard shortcut):

1. **"+" hover button** - appears on hover over any diff-highlighted line. Click opens the panel.
2. **Text selection button** - selecting text on highlighted lines shows a floating comment button on the right (Notion-style).

Both only work on added/modified lines.

## Multi-line Comments

- Selecting text spanning multiple highlighted lines creates a multi-line range
- Both start and end lines are mapped through the diff mapper (`start_line` + `line`)
- Panel header shows "New comment on lines 42-48"
- If only one line maps, falls back to single-line

# Error Handling

Six categories, split by recoverable vs terminal:

| Category | Type | Detection | User sees |
|----------|------|-----------|-----------|
| gh not installed | Terminal | execFile ENOENT | VS Code notification with install link |
| Not authenticated | Terminal | `gh auth status` non-zero | "Run `gh auth login`" notification |
| Token expiry mid-session | Recoverable | 401/403 on any API call | Specific re-auth message, Refresh to retry |
| No PR / dirty file / file not in diff | Terminal | Various checks on toggle | Toggle stays OFF, error tooltip |
| Line unmappable | Terminal (this comment) | validateLineMapping returns null | Inline error in panel |
| Submit failed | Recoverable | gh API non-zero exit | Error popup, pending preserved for retry |

Retry always re-validates everything (commit SHA + line mapping). Double-submit prevention: Submit button disabled on click until result arrives.

# Degraded Mode

If `gh pr diff` fails but comments succeed:
- Existing comments shown with approximate positions (using `original_line`)
- New comments disabled
- Persistent banner: "Diff unavailable - positions may be inaccurate. New comments disabled."
- Replies to existing threads still work (they use `in_reply_to`, no mapping needed)

# gh CLI Call Sequence

```
Toggle ON:
  Sequential:  gh auth status → gh pr view
  Parallel:    gh api .../comments | gh pr diff | gh api user

Refresh:
  Parallel:    gh api .../comments | gh pr diff
  (PR info + user cached from toggle-on)

Submit:
  Sequential:  gh api .../pulls/{n} (SHA) → POST review → POST replies
```

Each `gh` call takes ~1-2s. Parallelisation brings toggle-on from ~8s worst case to ~4s.

# Cache Strategy

| Data | Cached | Refreshed | Cleared |
|------|--------|-----------|---------|
| PR info (number, url, refs) | Per session | Never (until reload) | Window close |
| Current user login | Per session | Never | Window close |
| Comments + threads | Per file, in-memory | Every Refresh | Toggle OFF, file close, 1h TTL |
| Diff + line mappings | Per file, in-memory | Every Refresh | Toggle OFF, file close, 1h TTL |
| Pending queue | workspaceState | On every change | Successful submit |

Cache persists across tab switches. Switching files and back does not re-fetch.

# Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Posting mode | Batch-only | One notification per review; matches GitHub's review model. Single reply = queue one + submit. |
| Review mode editing | Disabled (read-only) | Eliminates line-drift entirely. No need to rebuild mappings on edit. |
| Multi-line comments | Included in v1 | Diff highlighting guarantees valid mappings for both start/end lines. |
| Pending queue persistence | workspaceState via messages | Prevents accidental loss on reload without making extension own state. |
| Resolved thread indicators | Cut for v1 | Avoids GraphQL dependency. Low cost of replying to a resolved thread. |
| Conflict detection | Cut entirely | GitHub doesn't do it client-side. Chronological ordering handles it. |
| Pending comment editing | Cut | Discard and re-add is sufficient. |
| Comment deletion/editing | Not supported | Edit/delete on GitHub, then Refresh. |
| Retry semantics | Full re-validation | Re-fetch SHA + re-validate line mapping before resending. |
| Dirty file handling | Block review mode | Prevents all line-mapping drift from uncommitted changes. |
| gh CLI as sole interface | No OAuth/tokens | Piggyback on user's existing `gh auth`. Zero auth UI in the extension. |

# Sync Protocol Additions

New message types added to the existing `syncProtocol.ts` discriminated union:

**Extension to Webview**: `commentData`, `reviewSubmitResult`, `commentError`, `lineMappingResult`, `savedPendingQueue`

**Webview to Extension**: `commentToggle`, `commentRefresh`, `commentOpenPr`, `validateLine`, `submitReview`, `savePendingQueue`

Details in LLD.

# New Files

```
src/gh/
  ghCli.ts              — gh CLI wrapper (execFile, errors, availability)
  prDetector.ts         — PR detection, repo info, open in browser
  commentFetcher.ts     — fetch comments, group threads, detect outdated
  commentPoster.ts      — batch review submission + reply posting
  diffLineMapper.ts     — parse diff hunks, bidirectional line mapping
src/sync/
  commentTypes.ts       — shared type definitions
src/webview/
  commentPanel.ts       — right-margin floating panel
  commentIndicator.ts   — ProseMirror plugin: diff highlights, badges, "+" button
  commentToggle.ts      — Review toggle, Submit Review, Refresh, staleness
  pendingCommentStore.ts — local pending queue with persistence bridge
```

# Limitations (by design)

- Comments only on added/modified lines (not context or deleted lines)
- Current file only - no cross-file navigation
- Single PR per branch (most recent)
- No comment editing/deletion from the extension
- Comment-only reviews (no approve/request-changes)
- Duplicate risk on network failure mid-post (documented, not surfaced in UI)
- WYSIWYG-to-markdown line mapping is approximate for complex structures (tables, nested lists)
- GitHub only - no GitLab/Bitbucket/Azure DevOps
