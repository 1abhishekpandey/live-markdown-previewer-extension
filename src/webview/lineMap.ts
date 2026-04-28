import type { Node as PmNode } from '@tiptap/pm/model';

export interface LineRange {
  startLine: number; // 0-indexed, inclusive
  endLine: number;   // 0-indexed, exclusive
}

export interface LineMap {
  posToLineRange: Map<number, LineRange>;
  lineToPos: Map<number, number>;
}

interface MdToken {
  type: string;
  nesting: -1 | 0 | 1;
  map: [number, number] | null;
  hidden?: boolean;
}

interface MarkdownItParser {
  parse(src: string, env: Record<string, unknown>): MdToken[];
}

const WRAPPER_TOKENS = new Set([
  'thead_open', 'thead_close',
  'tbody_open', 'tbody_close',
]);

export function buildLineMap(
  doc: PmNode,
  markdown: string,
  md: MarkdownItParser,
): LineMap {
  const tokens = md.parse(markdown, {});
  const posToLineRange = new Map<number, LineRange>();

  const walker = new TokenWalker(tokens, posToLineRange, markdown);
  walker.walkDoc(doc);

  const lineToPos = buildReverseMap(posToLineRange);
  return { posToLineRange, lineToPos };
}

export function findPosForLine(map: LineMap, line: number): number | null {
  return map.lineToPos.get(line) ?? null;
}

export function findLineForPos(map: LineMap, pos: number): number | null {
  const range = map.posToLineRange.get(pos);
  return range ? range.startLine : null;
}

function buildReverseMap(
  posToLineRange: Map<number, LineRange>,
): Map<number, number> {
  const lineToPos = new Map<number, number>();

  for (const [pos, range] of posToLineRange) {
    const rangeSize = range.endLine - range.startLine;
    for (let line = range.startLine; line < range.endLine; line++) {
      const existing = lineToPos.get(line);
      if (existing === undefined) {
        lineToPos.set(line, pos);
      } else {
        const existingRange = posToLineRange.get(existing)!;
        const existingSize = existingRange.endLine - existingRange.startLine;
        if (rangeSize < existingSize) {
          lineToPos.set(line, pos);
        }
      }
    }
  }

  return lineToPos;
}

class TokenWalker {
  private tokens: MdToken[];
  private idx = 0;
  private result: Map<number, LineRange>;
  private markdown: string;

  constructor(tokens: MdToken[], result: Map<number, LineRange>, markdown: string) {
    this.tokens = tokens;
    this.result = result;
    this.markdown = markdown;
  }

  walkDoc(doc: PmNode): void {
    const children: Array<{ node: PmNode; offset: number }> = [];
    doc.forEach((child, offset) => {
      children.push({ node: child, offset });
    });

    let childIdx = 0;
    while (childIdx < children.length) {
      const token = this.nextBlockToken();
      if (!token) break;

      if (token.type === 'html_block' && token.nesting === 0) {
        this.idx++; // consume html_block
        if (token.map) {
          const range: LineRange = { startLine: token.map[0], endLine: token.map[1] };
          const html = getSourceLines(this.markdown, range.startLine, range.endLine);
          const count = countHtmlBlockNodes(html);
          for (let j = 0; j < count && childIdx < children.length; j++) {
            this.result.set(children[childIdx].offset, range);
            childIdx++;
          }
        }
        // If count was 0 (e.g. HTML comment dropped by TipTap), childIdx is NOT
        // advanced — the next child aligns with the next token.
      } else {
        this.walkNode(children[childIdx].node, children[childIdx].offset);
        childIdx++;
      }
    }
  }

  private walkNode(node: PmNode, pos: number): void {
    const token = this.nextBlockToken();
    if (!token) return;

    if (token.map) {
      this.result.set(pos, {
        startLine: token.map[0],
        endLine: token.map[1],
      });
    }

    this.idx++; // consume the opening / self-closing token

    if (token.nesting === 0) {
      // Self-closing token (fence, hr) — done
      return;
    }

    // Opening token — recurse into block children if the token
    // tree also has block children. Table cells (th/td) are a special
    // case: the token has inline-only content but ProseMirror wraps it
    // in a paragraph (schema-enforced). Detect this by checking if the
    // very next token is 'inline' — if so, skip recursion.
    const hasBlockChildren =
      node.childCount > 0 && node.firstChild!.isBlock;
    const tokenHasInlineOnly =
      this.idx < this.tokens.length &&
      this.tokens[this.idx].type === 'inline';

    if (hasBlockChildren && !tokenHasInlineOnly) {
      node.forEach((child, offset) => {
        this.walkNode(child, pos + 1 + offset);
      });
    }

    // Skip past any remaining content + the matching close token
    this.consumeUntilMatchingClose();
  }

  /**
   * Advance past inline tokens and wrapper tokens to find
   * the next block-level opening or self-closing token.
   */
  private nextBlockToken(): MdToken | null {
    while (this.idx < this.tokens.length) {
      const t = this.tokens[this.idx];
      if (t.nesting === -1) { this.idx++; continue; }
      if (t.type === 'inline') { this.idx++; continue; }
      if (WRAPPER_TOKENS.has(t.type)) { this.idx++; continue; }
      return t;
    }
    return null;
  }

  /**
   * Skip past all remaining tokens until the matching close for
   * the current nesting level. Wrapper tokens (thead/tbody) are
   * excluded from depth counting — they have no ProseMirror
   * counterpart and must not cause an early exit.
   */
  private consumeUntilMatchingClose(): void {
    let depth = 1;
    while (this.idx < this.tokens.length && depth > 0) {
      const t = this.tokens[this.idx];
      const isWrapper = WRAPPER_TOKENS.has(t.type);
      if (!isWrapper && t.nesting === 1) depth++;
      if (!isWrapper && t.nesting === -1) depth--;
      this.idx++;
    }
  }
}

/**
 * Extract raw source lines from the markdown string.
 * startLine/endLine are 0-indexed, endLine is exclusive (matching markdown-it token.map).
 */
function getSourceLines(markdown: string, startLine: number, endLine: number): string {
  const lines = markdown.split('\n');
  return lines.slice(startLine, endLine).join('\n');
}

/**
 * Count how many top-level ProseMirror block nodes an html_block token
 * will produce when TipTap parses the raw HTML via ProseMirror's DOMParser.
 *
 * We parse the HTML into a temporary <div> and count top-level Element and
 * non-whitespace Text child nodes — the same children ProseMirror's DOMParser
 * would create block nodes from.
 */
function countHtmlBlockNodes(html: string): number {
  if (typeof document === 'undefined') return 1;
  const container = document.createElement('div');
  container.innerHTML = html;
  let count = 0;
  for (let i = 0; i < container.childNodes.length; i++) {
    const child = container.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE) {
      count++;
    } else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      count++; // bare text outside any element → ProseMirror wraps in paragraph
    }
    // Comment nodes (nodeType 8) are dropped by TipTap → don't count
  }
  return count;
}
