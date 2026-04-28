LLM Assist Mode — v0.6.0

LLM Assist is an opt-in annotation mode in the Live Markdown WYSIWYG editor. It lets you mark up a document with structured comments and then copy a machine-readable payload directly into any LLM chat — eliminating the manual work of locating, quoting, and contextualising sections of a document when asking an LLM for help. Nothing talks to a server. The mode is purely local, purely ephemeral, and its output is a block of text you paste wherever you like.

# How to use

1. Toggle the mode on via the **LLM-Assist: Off** button in the top-right toolbar, or run **Toggle LLM-Assist** from the Command Palette. The button label changes to **LLM-Assist: On** and a second control strip appears below the toolbar with **Copy all** and **Clear all** buttons.

2. Hover any block (paragraph, heading, list item, task item, code block, table row) to reveal a **+** button in the left gutter. Click it to open a floating comment panel anchored to that line. Type your note and save.

3. Select any text range within the document. A floating **+ Comment** button appears above the selection. Clicking it anchors a comment to that exact phrase and opens the same panel.

4. Comments support inline reply threads. Use the **prev / next** navigation in the panel to move between threads.

5. Each comment has three controls: **Edit** to reopen the input, **Copy** to copy just that comment's payload to the clipboard, and **Delete** to remove it.

6. **Copy all** in the control strip copies every thread in the document into one structured payload. **Clear all** wipes the entire comment store and removes all inline highlights.

7. Toggle the mode off to end the session. All comments are cleared immediately.

# Copy payload format

Each copied payload includes the workspace-relative file path, the exact source lines quoted verbatim, and your comment. When copying a single comment the output looks like this:

```
File: `docs/design.md`

> 42: retainContextWhenHidden: true avoids re-parsing markdown on tab switches

Comment-1 — Line 42:
Feedback: Expand this with a concrete example.
```

When using **Copy all** with multiple threads, each block is separated by `-----` and comments are numbered sequentially (`Comment-1:`, `Comment-2:`, ...). The `File:` header appears once at the top and applies to every comment in the payload.

The format is designed to be self-contained: the quoted text works standalone when you only paste the comments block, and the line numbers let the LLM jump directly to the right location when you also paste the full document into the chat.

# Limitations

- LLM Assist and PR Review mode are mutually exclusive — enabling one disables the other.

- Comments are ephemeral. They live in webview memory only and are not written to the markdown file or any sidecar file. They are cleared when the mode is toggled off, the tab is closed, or VS Code is restarted.

- There is no cross-session persistence and no re-anchoring after external edits. If the document changes while the session is active, line numbers in the payload may drift relative to the current file.

- Only one line-level comment is allowed per block. A gutter **+** no longer appears on a line that already has a line-level comment, though additional phrase-scoped comments on different text ranges within that line are still allowed.

- No LLM API is called from inside the extension. The mode produces a payload; you paste it wherever you prefer to chat.
