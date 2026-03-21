UX Analysis - PR Comments Feature

# Executive Summary

The PR comments feature is ambitious and well-specified, but introduces significant cognitive load and workflow friction that could undermine adoption. The core value proposition — reviewing PR comments without leaving VS Code — is sound. However, the spec prioritises feature completeness over usability. The primary recommendations are: cut the batch/immediate toggle (pick one mode for v1), replace selection-only commenting with a visible affordance, cut or downgrade conflict detection to informational-only, and add a staleness indicator. These changes would roughly halve the concept count and error surface area.

# Discoverability

## Review Toggle Placement
The "Review" button sits alongside "Copy: Raw" and "Wrap: Off" in the toolbar (OVERVIEW.md, line 10). This is reasonable placement — users already interact with that toolbar area. However, the button only appears when the file is on a branch with an open PR, meaning users cannot discover the feature exists until they happen to be in the right context.

## Comment Creation via Selection Only
The spec mandates text selection before commenting — no "add comment" button exists (OVERVIEW.md, line 211). This is a non-obvious interaction pattern. GitHub's web UI uses a "+" button on line gutters, which is far more discoverable. A user who wants to leave a comment has no visual affordance telling them to select text and press Cmd+Shift+C. GitHub's "+" button also works on blank lines in the diff — the extension cannot comment on blank lines at all since there is no text to select.

**Severity**: High. This is the single biggest discoverability gap. Users will look for a button, not find one, and assume the feature does not support creating comments.

**Recommendation**: Add a small "+" icon in the comment indicator gutter area that, when clicked, opens the comment panel anchored to that line. This is not additive complexity — it replaces an undiscoverable interaction (Cmd+Shift+C) with a standard one. Selection-based commenting can remain as an alternative for users who prefer keyboard shortcuts.

## Batch Toggle Hidden Semantics
The "Batch: ON/OFF" toggle appears when Review mode is on (OVERVIEW.md, line 33). The word "Batch" does not clearly communicate what it does. GitHub uses "Start a review" — a verb phrase that conveys intent. "Batch: ON" is abstract jargon.

**Recommendation**: This toggle should be cut entirely for v1 (see "Single Posting Mode" section below). If retained in future, relabel to "Pending review" or "Queue comments" to match GitHub's vocabulary.

# Cognitive Load

## Concept Count
The spec exposes concepts that require user decisions — not just awareness, but action:

- **Batch mode choice**: user must decide ON or OFF, understand implications of each
- **Conflict recovery**: user must copy text, discard, refresh, re-add
- **Line mapping errors**: user must understand why "this line cannot be mapped"
- **Manual refresh timing**: user must decide when to sync

GitHub has similar underlying concepts (pending reviews, outdated comments, resolved threads) but handles them transparently — the user never needs to make decisions about them. The extension surfaces internal mechanics that GitHub abstracts away. The real cognitive burden is not concept count but the number of concepts requiring user decisions.

**Recommendation**: Cut features that expose internal state to users: conflict detection (or make informational-only), batch/immediate toggle (pick one mode), and outdated indicators (cuttable for v1). This reduces user-facing decision points from ~4 to ~1 (manual refresh timing, mitigated by a staleness indicator).

# First-Run Experience

## Happy Path Walkthrough (Current Spec - Batch ON Default)
1. User opens a markdown file on a PR branch
2. User sees "Review" button, clicks it
3. Extension runs gh CLI checks (~1-2 seconds, OVERVIEW.md line 188)
4. Comments appear with line highlights
5. User clicks an indicator to see a thread
6. User wants to reply — types text, sees "Queue" button (Batch is ON by default)
7. User clicks "Queue" — comment appears as pending
8. User wonders: "Where did my comment go? Is it posted?" (the pending concept is new)
9. User notices "Submit Review (1)" in toolbar — clicks it
10. Confirmation prompt — user confirms
11. Comment is posted

This is 11 steps to post a single reply. On GitHub's web UI, it is: click reply, type, click "Add single comment" — 3 steps.

## Happy Path with Recommended Changes (Single Mode, No Conflict Detection)
1. User opens a markdown file on a PR branch
2. User sees "Review" button, clicks it
3. Comments appear with line highlights
4. User clicks an indicator to see a thread
5. User types a reply, clicks "Post"
6. Confirmation prompt — user confirms
7. Comment is posted

7 steps — still more than GitHub's 3, but the gap is inherent to the extension's architecture (toggle, loading). The key improvement: no conceptual surprises.

## Unhappy First Run
If the user does not have `gh` installed, the first click on "Review" produces an error notification (ERROR-HANDLING.md, section 1.1). This is a hard stop requiring terminal interaction. The error message includes an install link, which is good, but the user must leave VS Code, install a CLI tool, authenticate it, and return.

**Recommendation**: Document the `gh` dependency prominently in the extension's marketplace description and README.

# Workflow Friction

## Manual Refresh Only
The spec explicitly states "No background polling — user controls when to sync" (OVERVIEW.md, line 59). This means:
- A user viewing a thread will not see new replies from teammates unless they manually click Refresh
- There is no indication that the displayed comments might be stale
- Users accustomed to GitHub's real-time updates will find this jarring

**Recommendation**: Add a staleness indicator that checks the age of the last fetch when the user performs an action (opens a panel, starts typing). Display "Last refreshed N minutes ago" near the Review toggle. This is low-cost, high-value — it nudges users to refresh without adding automatic polling. All four reviewers independently converged on this recommendation.

## Conflict Detection Should Be Informational, Not Blocking
The current conflict detection flow (OVERVIEW.md, lines 49-56) requires 7 steps to recover. More critically, the clipboard-based recovery is a data loss risk: if a user copies their comment text then copies something else before pasting, the text is lost. With multiple conflicted comments in a batch, the clipboard is overwritten between copies.

GitHub does not do client-side conflict detection at all — you can always post a reply regardless of whether new comments appeared. The spec's flow is entirely invented friction.

**Recommendation**: Either cut conflict detection entirely (let GitHub handle chronological ordering) or make it informational-only: when opening a thread panel, show "N new replies since your last refresh" as a subtle notice, but never block posting. If conflict detection is retained in any form, conflicted comments should be kept in a "stashed" state — visible but greyed out, surviving across refreshes, re-submittable without re-typing (credit: error-analyst's formulation).

## One Panel at a Time
Only one comment panel can be open at a time (OVERVIEW.md, line 19). This means users cannot compare two threads side by side.

**Severity**: Low-medium. Reasonable constraint for v1 given limited right-margin space. Document as a known limitation.

## No Edit/Delete of Posted Comments
Users must go to GitHub to edit or delete posted comments (OVERVIEW.md, line 214-215). This is a reasonable scope cut but creates workflow asymmetry: the extension lets you create comments but not manage them.

**Recommendation**: Clearly communicate this limitation in the UI.

# Selection-Only Comments

Requiring text selection before commenting is the biggest UX concern. Specific issues:

1. **No visual affordance**: Nothing in the UI suggests that selecting text is how you create a comment. The Cmd+Shift+C shortcut is not discoverable without documentation.

2. **Context menu buried**: The right-click context action (OVERVIEW.md, line 27) is better than keyboard-only, but context menus are long in VS Code and the action may be hard to spot.

3. **Blank lines cannot receive comments**: If a line has no text to select, the user cannot comment on it. GitHub's "+" gutter button works on any line, including blank lines. This is a concrete parity gap.

4. **Multi-line selection complexity**: Selecting text across multiple lines creates a multi-line comment range (OVERVIEW.md, line 30). The mapping from WYSIWYG selection to markdown lines to diff lines is three layers of indirection, each of which can fail.

**Recommendation**: Add a line-gutter "+" button as the primary comment creation affordance. This replaces a hidden interaction with a standard, discoverable one. For v1, anchor comments to the clicked line (single-line only). Multi-line ranges via selection can be added in v2 — most review comments reference a specific line anyway, and anchoring to the last line of a selection (with a visible "commenting on line N" indicator) is a pragmatic middle ground that avoids the multi-line mapping complexity.

# Single Posting Mode

## The Toggle Must Go
The spec offers two posting modes (Batch ON/OFF) with a toggle. This doubles the UI surface, doubles the testing matrix, and adds edge cases (mode-switching warnings, different button labels, different confirmation flows). All four reviewers agree the toggle should be cut for v1.

## Immediate-Only vs Batch-Only Trade-offs

The team debated which single mode to keep. Both positions are defensible:

**Immediate-only (post on click):**
- One concept: "Post." No pending state, no Submit Review button, no queue.
- Optimises for the common case: a single reply to a thread.
- For a markdown-focused WYSIWYG editor, most interactions are "read comments, leave a quick reply."
- 3 actions per comment (type, post, confirm). Below 3 comments, fewer total actions than batch.
- Downside: each comment triggers a separate notification to PR participants. For 5+ comments, this creates notification noise.

**Batch-only (queue then submit):**
- One mode, no toggle — also simple, but introduces 2 concepts: "pending" and "submit."
- Optimises for the review workflow: leave multiple comments, submit as one review.
- Safer from an error-handling perspective: the user reviews all comments before submission.
- 2 actions per comment + 2 to submit. Above 3 comments, fewer total actions than immediate.
- Downside: a single reply requires 4 actions (type, queue, submit, confirm). The "where did my comment go?" confusion on first use.

**Recommendation for the project owner**: If the expected usage is primarily reading comments and leaving occasional replies (markdown review context), immediate-only is the better v1 choice. If the expected usage is thorough code review with multiple comments per file, batch-only is better. Either way, the toggle must not exist in v1.

# Error Recovery UX

## Error Messages are Well-Crafted
The error handling spec (ERROR-HANDLING.md) is thorough. Error messages follow the pattern "what happened + what the user can do", which is good UX practice. The categorisation by severity (blocker, degraded, action failure, informational) is well thought out.

## Partial Failure is Unavoidable but Must Be Communicated Clearly
Batch submission splits into a Reviews API call (new comments) and individual reply POSTs. The GitHub API does not support rollback of a submitted review, so partial failure (new comments succeed, some replies fail) is a genuine API constraint. The UX must make this mixed state legible: clearly separate "Posted successfully" (collapsed) from "Failed — retry or copy" (expanded with error detail). Presenting partial failure as a single atomic outcome is not possible given the API.

## Duplicate Risk on Network Errors
The spec acknowledges that a network timeout during POST may mean the comment was actually created server-side (ERROR-HANDLING.md, section 3.7). The mitigation ("If you see a duplicate comment on GitHub, you can delete it there") shifts cleanup burden to the user. An idempotency check before retry — fetch the thread and check if a comment with the same body by the current user was recently created — would be a more robust solution.

# Summary of Recommendations (Prioritised)

1. **Critical - Cut the batch/immediate toggle.** Pick one posting mode for v1. Present both trade-offs to the project owner. Either choice roughly halves the error surface area and removes 2-3 concepts.
2. **Critical - Add a visible comment creation affordance.** A line-gutter "+" button replaces the undiscoverable Cmd+Shift+C. Single-line comments only for v1; multi-line via selection in v2.
3. **High - Cut or downgrade conflict detection.** Either remove entirely (GitHub does not do this) or make informational-only ("N new replies appeared" with option to post anyway). Never block posting. If retained, use a stashed state for conflicted text — never clipboard-based recovery.
4. **High - Add a staleness indicator.** "Last refreshed N minutes ago" near the Review toggle. Check age on user actions (open panel, start typing). Low cost, high value.
5. **Medium - Cut outdated indicators for v1.** Informational visual state that adds rendering complexity without affecting workflow. Resolved indicators are worth keeping — they prevent users from replying to settled threads.
6. **Medium - Cut pending comment editing for v1.** Users can discard and re-add. Removes a UI state for trivial benefit.
7. **Low - Add idempotency check before retry.** Fetch thread and check for duplicate before re-posting on network error recovery.

# Changes After Debate

## What Changed

**1. Reframed cognitive load analysis (revised based on error-analyst's challenge)**
- Original: "10 distinct concepts vs GitHub's 4" — a raw count comparison.
- Revised: The real issue is not concept count but concepts requiring user decisions. GitHub has similar concepts but abstracts them away. The extension surfaces internal mechanics (line mapping, conflict state, batch mode) that demand user action.
- Why: error-analyst correctly pointed out that GitHub has the same underlying concepts (pending reviews, outdated comments, resolved threads) — the difference is transparency, not quantity.

**2. Strengthened recommendation to cut batch/immediate toggle (reinforced by all teammates)**
- Original: Recommended defaulting Batch to OFF.
- Revised: Recommended cutting the toggle entirely. Present both batch-only and immediate-only trade-offs to the project owner rather than advocating one.
- Why: devil-advocate argued convincingly that "one mode, no toggle" is simpler than "pick the better default." error-analyst added that batch mode is safer from an error-handling perspective (fewer per-comment checks). The team agrees the toggle must go; which mode to keep is a judgment call for the project owner.

**3. Dropped "Post and Queue" split button recommendation (conceded to github-parity)**
- Original: Suggested a split button for power users.
- Revised: Removed entirely.
- Why: github-parity noted this adds a third interaction pattern that exists nowhere on GitHub — more complexity, not less.

**4. Changed conflict detection from "preserve text across refresh" to "cut or make informational" (consensus across all teammates)**
- Original: Recommended keeping conflict detection but preserving comment text.
- Revised: Recommended cutting conflict detection entirely or making it informational-only (show notice, never block posting). If retained, use a "stashed" state rather than clipboard.
- Why: github-parity pointed out GitHub does not do conflict detection at all. devil-advocate argued it should be cut. error-analyst identified the clipboard approach as a data loss risk. The team consensus is that this flow creates more problems than it solves.

**5. Changed batch atomic submission to "communicate partial success clearly" (conceded to github-parity)**
- Original: Recommended making batch submission atomic.
- Revised: Acknowledged that the GitHub API does not support rollback of submitted reviews. Partial failure is an API constraint, not a design choice. The UX should make the mixed state legible rather than trying to prevent it.
- Why: github-parity explained that you cannot delete a review after submission. Atomic rollback is technically impossible.

**6. Dropped first-use notification and "Edit on GitHub" links (conceded to devil-advocate)**
- Original: Recommended onboarding hints and edit links.
- Revised: Removed both. If the feature needs onboarding, the interaction model is too complex — fix the model (add "+" button) rather than adding tutorials.
- Why: devil-advocate correctly challenged that my recommendations were adding UI elements to make complex features discoverable, when the right approach is to cut the complexity.

**7. Added single-line-only recommendation for v1 comments (adopted from devil-advocate)**
- Original: Did not specifically address multi-line scope.
- Revised: Recommend single-line comments only for v1, with multi-line via selection in v2.
- Why: devil-advocate showed that multi-line ranges add significant mapping complexity (start + end line validation, partial mapping failures) for marginal gain. Anchoring to the clicked/selected line covers the vast majority of review comments.

## What Did Not Change

- **Selection-only commenting is the biggest discoverability gap** — reinforced by all teammates.
- **Staleness indicator recommendation** — independently recommended by all four reviewers; adopted error-analyst's more specific formulation (check age on user actions).
- **Resolved thread indicators should be kept** — maintained against devil-advocate's recommendation to cut. Without resolved status, users waste time replying to settled threads. One GraphQL query is cheap.
- **One panel at a time is acceptable for v1** — no challenges received.
