PR Comments - Error Handling

Errors are organised into six categories based on the recoverable/terminal distinction: should we show a Retry button?

# Category 1: gh Not Available (Terminal)

- **Detection**: `execFile('gh', ...)` throws ENOENT
- **Message**: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com to use PR comments."
- **Toggle state**: stays OFF
- **Recovery**: user installs gh, clicks toggle again

# Category 2: Not Authenticated / Token Expired (Terminal)

## On toggle

- **Detection**: `gh auth status` exits non-zero
- **Message**: "GitHub CLI is not authenticated. Run `gh auth login` in your terminal."
- **Toggle state**: stays OFF
- **Recovery**: user runs `gh auth login`, clicks toggle again

## Mid-session

- **Detection**: any gh API call returns 401 or 403 with "Bad credentials" or "token expired"
- **Message**: "Your GitHub authentication has expired. Run `gh auth login` to re-authenticate, then Refresh."
- **Display**: inline error in comment panel
- **Recovery**: user runs `gh auth login`, clicks Refresh

# Category 3: No PR / PR Closed (Terminal)

All sub-cases result in the toggle staying OFF. Messages vary by sub-case:

- **No PR**: `gh pr view` exits non-zero with "no pull requests found"
- **PR closed/merged**: `gh pr view --json state` returns "CLOSED" or "MERGED"
- **Not a git repo**: `gh pr view` fails with "not a git repository"
- **File not in diff**: diff parsing finds no hunks for the current file
- **Dirty file (uncommitted)**: `git diff HEAD -- <file>` produces output
- **Dirty file (unpushed)**: `git log @{u}..HEAD -- <file>` produces output
- **Message**: "This file has local changes that haven't been pushed. Commit and push your changes before enabling review mode."

# Category 4: Line Unmappable (Terminal for This Comment)

- **Detection**: `validateLineMapping()` returns null
- **Message**: "This line is not part of the PR diff. Only lines added or modified in the PR can receive comments."
- This should be very rare with diff highlighting since users can only comment on highlighted lines
- Acts as a safety net for edge cases where mapping drifts

# Category 5: Post Failed, Recoverable (Show Retry)

A Retry button is shown. Retry re-validates everything: re-fetches commit SHA, re-validates line mapping, then posts. Comment text is preserved in the pending queue (batch mode).

Triggers:

- **Stale commit SHA**: 422 with "commit_id is not part of the pull request"
- **Network timeout / connection refused**
- **Rate limit exceeded**: include reset time if available from headers
- **Generic API error**: non-zero exit, not matching terminal patterns

# Category 6: Post Failed, Terminal (No Retry)

Message tells user to copy their comment text and go to GitHub. Pending comments are preserved but submission is blocked.

Triggers:

- **Permission denied**: 403 "Resource not accessible by integration" or "Must have write access"
- **PR closed mid-submission**: 422 "pull request is closed"

# Additional Error Behaviours

## Double-submit prevention

Submit Review button is disabled immediately on click and stays disabled until the result arrives. This is a guard, not an error case.

## Duplicate comment risk on network failure

If a network error occurs mid-post, the comment may have been created server-side. Retry could create a duplicate. The Retry button is shown without special labelling. This is documented in `limitations.md`.

## gh CLI output parse failures

If gh output fails to parse (malformed JSON, unexpected format), show: "Unexpected response from GitHub CLI. Check with `gh --version` and update if needed." Log full output to the extension output channel.

## Token expiry mid-session

Detected on any 401/403 during post or refresh, mapped to Category 2 message.

# Error Display Strategy

- **Blocker** (can't enable feature): VS Code notification (error)
- **Action failure** (post failed): inline in comment panel (red state) with Retry or error detail
- **Informational**: inline text, no modal

# Error Message Principles

- Lead with what happened, then what the user can do
- Include the PR number where relevant
- Sanitise gh stderr (strip paths, tokens) before showing
- Never show raw stack traces - log to the "LiveMarkdown" output channel
- Rate limit: show reset time if available ("Rate limit resets in N minutes") instead of generic "try again later"

# Degraded Mode (Diff Fetch Failure)

If `gh pr diff` fails:

- New comments are disabled
- Existing comments are shown with approximate positions using `original_line`
- Show persistent banner: "Diff unavailable - comment positions may be inaccurate. New comments disabled."
- Allow replies to existing threads (replies use `in_reply_to`, no line mapping needed)
- Mark approximate positions visually ("~Line 42")
