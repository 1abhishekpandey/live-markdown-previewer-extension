// Backtick-delimited inline code spans don't need markdown escaping for these
// characters, but prosemirror-markdown's renderInline incorrectly escapes them
// when a non-code mark (e.g. llmComment) sits above the code mark. This
// reverses that over-escape inside inline code spans only.
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g;
const ESCAPED_CHAR_RE = /\\([`*\\~\[\]_])/g;

export function unescapeInlineCode(markdown: string): string {
  return markdown.replace(INLINE_CODE_RE, (_match, fence, inner) =>
    `${fence}${inner.replace(ESCAPED_CHAR_RE, '$1')}${fence}`,
  );
}
