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

  const walker = new TokenWalker(tokens, posToLineRange);
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

  constructor(tokens: MdToken[], result: Map<number, LineRange>) {
    this.tokens = tokens;
    this.result = result;
  }

  walkDoc(doc: PmNode): void {
    doc.forEach((child, offset) => {
      this.walkNode(child, offset);
    });
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
