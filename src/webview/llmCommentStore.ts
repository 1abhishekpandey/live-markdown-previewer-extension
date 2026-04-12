import type { Editor } from '@tiptap/core';
import type { LineMap } from './lineMap';

export interface LlmComment {
  id: string;
  kind: 'line' | 'text';
  body: string;
  createdAt: number;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed; startLine === endLine for kind: 'line'
  parentId?: string;
}

export class LlmCommentStore {
  private comments: LlmComment[] = [];
  private listeners: Set<() => void> = new Set();

  add(comment: LlmComment): void {
    this.comments.push(comment);
    this.notify();
  }

  remove(id: string): void {
    const target = this.comments.find(c => c.id === id);
    if (target && !target.parentId) {
      // Root — remove root + all its replies
      this.comments = this.comments.filter(c => c.id !== id && c.parentId !== id);
    } else {
      // Reply or not found — remove just this one
      this.comments = this.comments.filter(c => c.id !== id);
    }
    this.notify();
  }

  update(id: string, body: string): void {
    this.comments = this.comments.map(c =>
      c.id === id ? { ...c, body } : c,
    );
    this.notify();
  }

  clear(): void {
    this.comments = [];
    this.notify();
  }

  get(id: string): LlmComment | undefined {
    return this.comments.find(c => c.id === id);
  }

  getAll(): LlmComment[] {
    return [...this.comments];
  }

  getCount(): number {
    return this.comments.length;
  }

  getForLine(line1: number): LlmComment[] {
    const matches = this.comments.filter(
      c => c.startLine <= line1 && line1 <= c.endLine && !c.parentId,
    );
    return matches.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'line' ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });
  }

  getReplies(rootId: string): LlmComment[] {
    return this.comments
      .filter(c => c.parentId === rootId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  toPayload(
    editor: Editor,
    filePath: string,
    lineMap?: LineMap | null,
    rawMarkdown?: string,
  ): string {
    if (this.comments.length === 0) {
      return '';
    }

    // Get only root comments, sorted
    const roots = this.comments
      .filter(c => !c.parentId)
      .sort((a, b) => {
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        if (a.kind !== b.kind) {
          return a.kind === 'line' ? -1 : 1;
        }
        return a.createdAt - b.createdAt;
      });

    const totalCount = roots.length;
    const blocks = roots.map((root, index) => {
      const replies = this.getReplies(root.id);
      return formatThreadBlock([root, ...replies], index, totalCount, editor, lineMap ?? null, rawMarkdown);
    });

    return `File: \`${filePath}\`\n\n` + blocks.join('\n\n---\n\n');
  }

  toLinePayload(
    line1: number,
    editor: Editor,
    filePath: string,
    lineMap?: LineMap | null,
    rawMarkdown?: string,
  ): string {
    const roots = this.getForLine(line1);
    if (roots.length === 0) return '';

    const total = roots.length;
    const blocks = roots.map((root, index) => {
      const replies = this.getReplies(root.id);
      return formatThreadBlock([root, ...replies], index, total, editor, lineMap ?? null, rawMarkdown);
    });

    return `File: \`${filePath}\`\n\n` + blocks.join('\n\n---\n\n');
  }

  toThreadPayload(
    rootId: string,
    editor: Editor,
    filePath: string,
    lineMap?: LineMap | null,
    rawMarkdown?: string,
  ): string {
    const root = this.comments.find(c => c.id === rootId && !c.parentId);
    if (!root) return '';

    const replies = this.getReplies(rootId);
    const block = formatThreadBlock([root, ...replies], 0, 1, editor, lineMap ?? null, rawMarkdown);
    return `File: \`${filePath}\`\n\n` + block;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function formatThreadBlock(
  thread: LlmComment[],
  index: number,
  total: number,
  editor: Editor,
  lineMap: LineMap | null,
  rawMarkdown?: string,
): string {
  const root = thread[0];
  const lineHeader = formatLineHeader(root.startLine, root.endLine);
  const quoted = extractQuotedText(editor, root, lineMap, rawMarkdown);
  const commentLabel = total === 1 ? 'Comment' : `Comment ${index + 1}`;
  const feedbackLabel = total === 1 ? 'Feedback:' : `Feedback-${index + 1}:`;

  // Combine all bodies in the thread (root + replies)
  const combinedBody = thread.map(c => c.body).join('\n\n');

  return (
    `${commentLabel} — ${lineHeader}:\n` +
    `Selected text:\n` +
    `"""\n${quoted}\n"""\n\n` +
    `${feedbackLabel}\n` +
    `"""\n${combinedBody}\n"""`
  );
}

function formatLineHeader(startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `Line ${startLine}`;
  }
  return `Lines ${startLine}-${endLine}`;
}

function extractQuotedText(
  editor: Editor,
  comment: LlmComment,
  lineMap: LineMap | null,
  rawMarkdown?: string,
): string {
  // Text comments: extract only the marked (selected) text from the editor,
  // not the full line(s). The mark covers exactly what the user highlighted.
  if (comment.kind === 'text') {
    return extractMarkText(editor, comment.id);
  }
  // Line comments: extract full line(s) from raw markdown when available.
  if (rawMarkdown) {
    const lines = rawMarkdown.split('\n');
    return lines.slice(comment.startLine - 1, comment.endLine).join('\n');
  }
  return extractLineText(editor, comment.startLine, lineMap);
}

interface LineMapStorage {
  getTextForLine(line: number): string;
}

interface MarkTextStorage {
  getTextForId(id: string): string;
}

function extractLineText(editor: Editor, line: number, lineMap: LineMap | null): string {
  // Primary path: use the real lineMap when available (line is 1-indexed; lineToPos is 0-indexed).
  if (lineMap) {
    const pos = lineMap.lineToPos.get(line - 1);
    if (pos !== undefined) {
      const node = editor.state?.doc?.nodeAt(pos);
      return node?.textContent ?? '';
    }
    return '';
  }

  // Test fallback: honour editor.storage.llmLineMap mock if provided.
  const storageLm = (editor.storage as Record<string, unknown> | undefined)?.['llmLineMap'] as
    | LineMapStorage
    | undefined;
  if (storageLm && typeof storageLm.getTextForLine === 'function') {
    return storageLm.getTextForLine(line) ?? '';
  }

  const doc = editor.state?.doc;
  if (!doc || typeof doc.descendants !== 'function') {
    return '';
  }

  let currentLine = 1;
  let result = '';
  try {
    doc.descendants((node: unknown) => {
      const n = node as { isBlock?: boolean; textContent?: string };
      if (n.isBlock) {
        if (currentLine === line) {
          result = n.textContent ?? '';
          return false;
        }
        currentLine += 1;
      }
      return true;
    });
  } catch {
    return '';
  }
  return result;
}

function extractMarkText(editor: Editor, commentId: string): string {
  const markText = (editor.storage as Record<string, unknown> | undefined)?.['llmMarkText'] as
    | MarkTextStorage
    | undefined;
  if (markText && typeof markText.getTextForId === 'function') {
    return markText.getTextForId(commentId) ?? '';
  }

  const doc = editor.state?.doc;
  if (!doc || typeof doc.descendants !== 'function') {
    return '';
  }

  const parts: string[] = [];
  try {
    doc.descendants((node: unknown) => {
      const n = node as {
        isText?: boolean;
        text?: string;
        marks?: ReadonlyArray<{
          type?: { name?: string };
          attrs?: { commentId?: string };
        }>;
      };
      if (n.isText && n.marks) {
        const hasMark = n.marks.some(
          m => m.type?.name === 'llmComment' && m.attrs?.commentId === commentId,
        );
        if (hasMark && n.text) {
          parts.push(n.text);
        }
      }
      return true;
    });
  } catch {
    return '';
  }
  return parts.join('');
}
