import type { Editor } from '@tiptap/core';

export interface LlmComment {
  id: string;
  kind: 'line' | 'text';
  body: string;
  createdAt: number;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed; startLine === endLine for kind: 'line'
}

export class LlmCommentStore {
  private comments: LlmComment[] = [];
  private listeners: Set<() => void> = new Set();

  add(comment: LlmComment): void {
    this.comments.push(comment);
    this.notify();
  }

  remove(id: string): void {
    this.comments = this.comments.filter(c => c.id !== id);
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
      c => c.startLine <= line1 && line1 <= c.endLine,
    );
    return matches.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'line' ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  toPayload(editor: Editor, filePath: string): string {
    if (this.comments.length === 0) {
      return '';
    }

    const sorted = [...this.comments].sort((a, b) => {
      if (a.startLine !== b.startLine) {
        return a.startLine - b.startLine;
      }
      if (a.kind !== b.kind) {
        return a.kind === 'line' ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });

    const totalCount = sorted.length;
    const blocks = sorted.map((comment, index) => {
      const header = formatLineHeader(comment.startLine, comment.endLine);
      const quoted = extractQuotedText(editor, comment);
      const label = totalCount === 1 ? 'Comment:' : `Comment-${index + 1}:`;
      return (
        `${header} — Selected text:\n` +
        `"""\n${quoted}\n"""\n\n` +
        `${label}\n` +
        `"""\n${comment.body}\n"""`
      );
    });

    return `File: ${filePath}\n\n` + blocks.join('\n\n-----\n\n');
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function formatLineHeader(startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `Line ${startLine}`;
  }
  return `Lines ${startLine}-${endLine}`;
}

function extractQuotedText(editor: Editor, comment: LlmComment): string {
  if (comment.kind === 'line') {
    return extractLineText(editor, comment.startLine);
  }
  return extractMarkText(editor, comment.id);
}

interface LineMapStorage {
  getTextForLine(line: number): string;
}

interface MarkTextStorage {
  getTextForId(id: string): string;
}

function extractLineText(editor: Editor, line: number): string {
  const lineMap = (editor.storage as Record<string, unknown> | undefined)?.['llmLineMap'] as
    | LineMapStorage
    | undefined;
  if (lineMap && typeof lineMap.getTextForLine === 'function') {
    return lineMap.getTextForLine(line) ?? '';
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
