PR Comments Integration

# Overview

Add inline GitHub PR review comments to the LiveMarkdown WYSIWYG preview. Users can view, reply to, and create new review comments directly from the editor - without leaving VS Code.

# User Flow

1. User opens a markdown file on a branch that has an open PR
2. A "Review" toggle button appears alongside "Copy: Raw" and "Wrap: Off" (default: off)
3. Clicking it enables review mode:
   - If the file has uncommitted or unpushed local changes, the toggle stays OFF with error: "This file has local changes that haven't been pushed. Commit and push your changes before enabling review mode."
   - PR is detected via `gh` CLI; button updates to "Review: ON  PR #123"
   - "PR #123" portion is clickable - opens the PR on GitHub in the browser
   - Existing review comments are fetched for the current file, along with the full diff
   - Added/modified lines are highlighted with a green background (diff line highlighting)
   - Lines with comments get a subtle comment indicator icon
   - All comment panels are collapsed by default
   - Editing is disabled - the editor becomes read-only while review mode is ON
   - A "Last refreshed N min ago" staleness indicator appears near the Review toggle
4. Viewing comments:
   - Click a comment indicator to expand its right-margin panel
   - Only one panel is open at a time - clicking another closes the previous
   - Panel has a fixed max-height (300px) and scrolls internally for long threads
   - Each comment in the thread shows: author, relative timestamp, body (plain text)
   - Outdated comments (where the REST API `line` field is null) are shown with a faded "Outdated" label - same concept as GitHub's outdated indicator
   - A reply input box sits at the bottom of each thread
5. Creating new comments:
   - Two affordances (no keyboard shortcut):
     - "+" hover button on highlighted (diff) lines - click to open the comment panel
     - Text selection on highlighted lines - a small floating comment button appears on the right side of the selection (similar to Notion's comment affordance)
   - Comments can only be created on added/modified lines (highlighted green in review mode)
   - Comment input panel appears anchored to the line in the right margin
   - Extension maps the position back to markdown line(s), then to diff line(s)
   - If the selection spans multiple lines, both start and end lines are mapped to diff lines, creating a multi-line comment range (`start_line` + `line` in GitHub's API)
   - Since diff highlighting guarantees both start and end lines are mappable, multi-line comments work reliably
6. Posting mode - batch-only:
   - All comments and replies are queued locally as "pending" - not posted immediately
   - Pending comments appear in the panel with a dashed border and "Pending" label
   - Each pending comment can be individually discarded (X button) before submission
   - No edit button on pending comments - discard and re-add instead
   - A "Submit Review (N)" button appears in the toolbar showing the pending count
   - Clicking "Submit Review" posts all pending comments as a single GitHub review (COMMENT event) with `body: ""` (no review summary text, pure inline comments only)
   - Reviewers get one notification, not N separate ones
   - Confirmation prompt: "Submit N comments to PR #123?"
   - On confirm: loading spinner, then green checkmark on success
   - On failure: error popup with details; pending comments are preserved for retry
   - If user wants to post a single comment, they queue one and hit Submit Review
7. Sync:
   - Comments and diff are fetched on toggle-on and via a manual "Refresh" button
   - No background polling - user controls when to sync
   - Staleness indicator shows "Last refreshed N min ago" to nudge the user to refresh
   - If a submit fails due to a stale state, show error and suggest refreshing

# UI Decisions

## Toggle buttons (toolbar)

```
Review OFF:
  [ Copy: Raw ] [ Wrap: Off ] [ Review ]

Review ON:
  [ Copy: Raw ] [ Wrap: Off ] [ Review: ON  PR #123 ] [ Refresh ] [ Submit Review (3) ]
```

- **Review toggle**: `[ Review ]` when off -> `[ Review: ON  PR #123 ]` when enabled
  - "PR #123" is clickable (opens PR on GitHub via `gh pr view --web`)
  - If no open PR found: show error tooltip "No open PR for this branch"
- **Staleness indicator**: shown near the Review toggle, displays "Last refreshed N min ago"
- **Submit Review button**: only visible when pending comments exist
  - Shows count: `[ Submit Review (3) ]`
  - Disabled on click until result arrives (double-submit prevention)
  - Clicking triggers confirmation -> batch post -> success/error state

## Diff line highlighting

- When review mode is ON, added/modified lines are highlighted with a green background
- Only added lines - context lines (unchanged) are NOT highlighted or commentable
- Deleted lines are skipped (they don't exist in the working copy)
- Highlighting is hidden when the toggle is OFF

## Comment panel (right margin)

- Positioned as a floating panel on the right side, anchored to the highlighted line
- Only one panel expanded at a time; clicking another collapses the current one
- Max-height: 300px with internal scroll for long threads
- Thread layout: author + timestamp header, body text, nested replies below
- Reply input at the bottom with a "Queue" button - adds to pending batch
- Pending comments shown with a dashed border and "Pending" label
- Each pending comment has a Discard (X) button - removes the pending comment from the queue
- No edit button on pending comments - discard and re-add instead
- Posted comments have no edit or delete option - edit/delete on GitHub and Refresh
- Outdated comments show a faded "Outdated" label (same as GitHub's UI)

## Comment creation affordances

- "+" hover button appears on highlighted (diff) lines - click to open the comment panel
- Text selection on highlighted lines shows a small floating comment button on the right side of the selection (similar to Notion's comment affordance)
- No keyboard shortcut (no Cmd+Shift+C)
- Comments can only be created on added/modified lines

## Comment indicators

- Lines with comments get a subtle background highlight (visible only when toggle is ON)
- A small icon/badge on the right edge of the line shows comment count (e.g., "2")
- Click the indicator to expand the panel
- Lines with pending comments get a different indicator style (e.g., dashed outline)
- When toggle is OFF: no highlights, no indicators - editor looks exactly as before

## Post states (Submit Review)

- Idle: "Submit Review (N)" button
- Confirming: "Submit N comments to PR #123?" with Confirm/Cancel
- Loading: spinner replacing the button (button disabled to prevent double-submit)
- Success: green checkmark, auto-fades after 2s, pending comments become real comments
- Partial failure: green for succeeded, red for failed replies (kept pending)
- Full failure: red icon + error popup with details, all pending preserved

## Error handling

Six categories (recoverable vs terminal):

- **gh CLI not found** (terminal): VS Code notification with install link (https://cli.github.com)
- **gh not authenticated** (terminal): VS Code notification suggesting `gh auth login`
- **Token expiry mid-session** (recoverable): specific re-auth message displayed
- **No open PR / file not in diff** (terminal for review mode): error tooltip on toggle button, toggle stays OFF
- **Line can't be mapped to diff** (recoverable): warning in the comment panel, "Cannot map to PR diff - file may have changed significantly"
- **Submit failed / network issues** (recoverable): error popup with gh CLI stderr, pending comments kept for retry

Retry re-validates everything (commit SHA, line mapping).

# Architecture

## gh CLI dependency

- No GitHub API tokens or OAuth in the extension
- All GitHub operations go through `gh` CLI (must be installed and authenticated)
- Extension calls `gh` via Node.js `child_process.execFile` on the extension side
- If `gh` is not found: show VS Code error notification with install link
- If `gh auth` fails: show notification suggesting `gh auth login`

## Two-context communication

- **Extension side (Node.js)**: runs `gh` CLI commands, manages comment state, detects PR, translates line numbers, enforces dirty-file check
- **Webview side (Browser)**: renders comment UI, handles user interactions, manages panel open/close state, holds pending comment queue, enforces read-only mode during review
- New message types added to `syncProtocol.ts` for comment data flow

## PR Detection

- Run `gh pr view --json number,url,headRefName` on the current repo's working directory
- If no PR found, disable the toggle with a tooltip
- Cache the PR info per workspace session (don't re-detect on every toggle or refresh)

## Comment Fetching

- Toggle ON -> fetch ALL PR comments + full diff in one go
- Filter to current file only, discard the rest
- Keep only current file's comments + diff mapping in memory
- `gh api repos/{owner}/{repo}/pulls/{number}/comments` for review comments
- Group by `in_reply_to_id` to build threads
- Map `line` / `original_line` to working-copy line numbers using diff hunk data
- Outdated detection: REST API `line` field being null indicates the comment is outdated (near-zero cost)

## Cache Strategy

- Comments cached per-file in memory while toggle is ON
- Persists across tab switches - switching to another file and back does not re-fetch
- Cleared when: toggle OFF, file closed, VS Code window closed/reloaded, or 1-hour TTL expires
- Staleness indicator shows age; TTL is the hard cutoff

## Performance

- Parallelise independent gh CLI calls on toggle-on: auth + PR detection first, then comments + diff + current user in parallel
- Cache PR info + current user per session (don't re-fetch on Refresh)
- Fetch comments + diff fresh on every Refresh

## Line Mapping

- PR review comments reference diff lines (right side), not working-copy lines
- Fetch the PR diff: `gh pr diff {number}`
- Parse diff hunks for the current file to build a mapping: diff line -> working copy line
- Dirty files (uncommitted/unpushed local changes) block review mode entirely, avoiding line mapping drift
- Fallback: use `original_line` with best-effort mapping
- Before allowing a new comment: validate that the selected line can be mapped to the diff; if not, show an error

## Batch Review Posting

- Webview holds the pending comment queue (array of { line, body, threadId? })
- On "Submit Review", webview sends the full batch to the extension
- Extension uses GitHub's "Create a review" API:
  `POST /repos/{owner}/{repo}/pulls/{number}/reviews`
  with `event: "COMMENT"`, `body: ""`, and `comments: [{ path, line, body }]`
- For replies to existing threads: posted separately via `POST .../comments` with `in_reply_to`
  (GitHub's review API doesn't support in_reply_to in the comments array)
- On success, all pending comments are cleared and comment data is re-fetched

## Text Preservation

- Comment body text is posted exactly as typed - no stripping or transformation
- Newlines, code blocks, suggestion syntax, and all markdown formatting are preserved as-is
- The extension sends the raw text; GitHub handles rendering on their side

# Key Technical Challenges

1. **Line mapping accuracy**: PR review comments reference diff lines. Need diff hunk parsing to translate to/from working-copy line numbers. Dirty-file detection prevents the worst drift by blocking review mode on uncommitted changes.
2. **Batch + replies split**: GitHub's review API handles new comments in batch, but replies to existing threads must be posted individually. The extension must split the pending queue accordingly.
3. **Performance**: `gh` CLI calls take ~1-2s. Parallelise independent calls, cache PR info and current user per session, show loading state.
4. **File identity**: File may have been renamed. Match by path; if no match, suggest the user check.
5. **Selection -> diff line mapping**: TipTap selection position needs to be mapped through markdown line(s) -> diff line(s). For multi-line selections, both start and end lines must be mapped. Diff highlighting guarantees mappability. Validate before queuing.

# Scope

## In scope

- View PR review comments inline in WYSIWYG preview (right margin panel)
- Reply to existing comment threads
- Create new line-specific review comments via "+" hover button or text selection on highlighted lines
- Diff line highlighting: added/modified lines shown with green background in review mode
- Multi-line comment ranges: selecting text spanning multiple lines maps both start and end to diff lines (`start_line` + `line`)
- Batch review mode (batch-only, no toggle): queue comments locally, submit all at once via "Submit Review"
- Read-only review mode: editing disabled while review toggle is ON
- Dirty file detection: files with uncommitted/unpushed changes cannot enter review mode
- Toggle on/off (default off) with PR number display
- "+" hover button on highlighted lines to create comments
- Staleness indicator: "Last refreshed N min ago" near the Review toggle
- 1-hour TTL cache eviction for comment data
- Loading/success/error states for submission (with double-submit prevention)
- Outdated comment indicator (faded "Outdated" label, matching GitHub's UI)
- Manual refresh for syncing
- Error handling (gh CLI missing, auth issues, token expiry, network errors, unmappable lines)
- Text preservation (newlines, code blocks, suggestion syntax sent as-is)

## Limitations (documented, by design)

- See [limitations.md](limitations.md) for the full limitations list
- **No direct comments on non-diff lines**: Comments can only be created on added/modified lines highlighted in review mode
- **Single PR per branch**: If multiple PRs exist for the same branch, only one is used (most recent). No PR switcher.
- **No comment deletion**: Cannot delete comments through the extension. Delete on GitHub and use Refresh to sync.
- **GitHub only**: Only GitHub PRs are supported. No GitLab, Bitbucket, or Azure DevOps. Extension depends on `gh` CLI.
- **No comment editing**: Cannot edit already-posted comments (or pending comments). Edit on GitHub and refresh, or discard and re-add for pending.
- **Comment-only reviews**: Batch submissions use the COMMENT event with empty body. No approve/request-changes support.
- **Comments on deleted lines**: If a comment's target line was deleted in the working copy, it cannot be displayed. These comments are visible on GitHub.
- **Current file only**: Only comments for the currently open file are shown. No cross-file comment navigation.

## Out of scope (future)

- Review submission with approve/request changes events
- Markdown rendering inside comment bodies (plain text first)
- Comment resolution/unresolve
- Resolved thread indicators (dimmed "Resolved" label, collapsed by default)
- Reactions/emoji on comments
- Background auto-polling
- Inline diff view
- Comment editing/deletion from extension
- PR switcher for branches with multiple PRs
- Conflict detection (re-fetch before submit)
- Edit pending comments in-place
