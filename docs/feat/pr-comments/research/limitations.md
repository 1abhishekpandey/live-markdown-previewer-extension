PR Comments - Known Limitations

# Deleted Lines

Comments on deleted lines (lines removed in the PR) cannot be displayed in the WYSIWYG preview. These lines no longer exist in the working copy, so there is no content to anchor a comment to.

- Existing comments on deleted lines are only viewable on GitHub
- The extension does not show a placeholder or indicator for these comments
- The PR badge link ("PR #123") provides quick access to the full GitHub view

# Context Lines

Only added or modified lines are highlighted and commentable in review mode. Unchanged context lines (lines visible in the diff but not modified) are not commentable through the extension.

- GitHub's web UI allows commenting on context lines; the extension does not
- To comment on an unchanged line, use GitHub's PR page directly

# Comment Scope

- **Added/modified lines only**: Comments can only be created on lines that were added or modified in the PR (highlighted green in review mode)
- **Current file only**: Only comments for the currently open file are shown. No cross-file comment navigation
- **Single PR per branch**: If multiple PRs exist for the same branch, only the most recent is used. No PR switcher

# Comment Management

- **No editing posted comments**: Comments that have been posted to GitHub cannot be edited through the extension. Edit on GitHub and use Refresh to sync
- **No deleting posted comments**: Comments that have been posted cannot be deleted through the extension. Delete on GitHub and use Refresh to sync
- **Comment-only reviews**: Batch submissions use the COMMENT event. No approve/request-changes support
- **Duplicate comments on network failure**: If a network error occurs mid-post, the comment may have been created server-side. Retrying could create a duplicate. Delete any duplicates on GitHub

# Review Mode is Read-Only

- **Editing disabled in review mode**: The WYSIWYG editor becomes read-only when the review toggle is ON. To edit the file, toggle review mode OFF first
- **Dirty files block review mode**: If the file has uncommitted or unpushed local changes, review mode cannot be enabled. The extension checks for local changes against the PR's head commit. Error shown: "This file has local changes that haven't been pushed. Commit and push your changes before enabling review mode."
- **Rationale**: Review mode displays the PR's diff state. Local modifications would invalidate the diff highlighting and line mapping, making comment positions unreliable

# Line Mapping

- **WYSIWYG-to-markdown mapping is approximate**: TipTap block nodes don't always map 1:1 to markdown lines. Tables, nested lists, and code blocks can span multiple markdown lines while appearing as a single block. Comment positions may be slightly off for complex markdown structures
- **Prototype required**: Line mapping accuracy must be validated with representative markdown files before building the full feature. If accuracy falls below ~90%, the approach needs revision

# Platform

- **GitHub only**: Only GitHub PRs are supported. No GitLab, Bitbucket, or Azure DevOps
- **Requires gh CLI**: The extension depends on the GitHub CLI (`gh`) being installed and authenticated. No built-in GitHub API integration
