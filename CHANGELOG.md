Changelog

All notable changes to the LiveMarkdown extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-03-31

# Features

- Three-way merge for markdown round-trip sync — preserves original formatting when the webview sends edits back, preventing unwanted whitespace and syntax changes

## [0.4.2] - 2026-03-22

# Changed

- Add marketplace keywords for better discoverability
- Update marketplace categories to Formatters and Visualization
- Add MIT license field to extension manifest

## [0.4.1] - 2026-03-21

# Fixed

- Correct line mapping between GitHub API and extension for PR review comments — fixes 422 errors when posting, off-by-one comment positioning, and missing comment indicators after submission

## [0.4.0] - 2026-03-21

# Features

- Inline PR review comments — view and post GitHub PR comments directly in the editor

# Fixed

- Eliminate scroll position drift when toggling between preview and raw mode

## [0.0.3] - 2026-03-08

# Fixed

- Use absolute GitHub URLs for licence links in README

# Changed

- Add `package` script and fix versioned install workflow

## [0.0.2] - 2026-03-08

# Fixed

- Wrap licence badge in link to render correctly on marketplace
- Remove malformed bracket in licence badge URL

# Documentation

- Add known issues doc and link from README
- Improve marketplace presentation in README

## [0.0.1] - 2026-03-08

Initial release.

# Features

- TipTap-based WYSIWYG markdown editor replacing VS Code's default markdown preview
- GFM support: tables, task lists, strikethrough, code blocks with syntax highlighting (lowlight)
- GFM alert decorations for `[!TYPE]` blockquotes (NOTE, TIP, IMPORTANT, WARNING, CAUTION)
- Raw markdown toggle via editor type switching
- Read-only mode for non-writable documents
- Search bar with find-in-editor functionality
- Loading overlay and adaptive debounce for smooth editing
- Scroll sync using text-anchor matching
- Ctrl+C wired to raw/rich toggle with floating toolbar removed
- Render local images with double-click to open
- Open local relative links on single click
- Relative links allowed by overriding TipTap's `isAllowedUri`
- Close-then-open pattern for single-tab WYSIWYG switching
- Native diff rendering in Source Control via option priority

# Security

- Hardened nonce generation, URL validation, and message handling
- CSP with nonce-based script-src

# Testing

- Vitest suite with 74 unit and integration tests

# Infrastructure

- CI workflow with type check, tests, and VSIX artifact
- esbuild dual-bundle config (extension CJS + webview IIFE)
- Extension icon, licence, and install script
- Full theme integration via `var(--vscode-*)` CSS variables

[0.5.0]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.0.3...v0.4.0
[0.0.3]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/1abhishekpandey/live-markdown-previewer-extension/releases/tag/v0.0.1
