import * as vscode from 'vscode';
import { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './syncProtocol';

export class DocumentSyncManager {
  private currentVersion: number = 0;
  private isApplyingEdit: boolean = false;
  private lastAppliedContent: string | null = null;
  private originalContent: string | null = null;
  private baselineContent: string | null = null;
  private document: vscode.TextDocument;
  private webview: vscode.Webview;
  private readonly isReadOnly: boolean;
  private readonly documentDirUri: string;
  private readonly workspaceRelativePath: string;
  // Serialize async message handling so edits land before subsequent undo/redo/save
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(document: vscode.TextDocument, webview: vscode.Webview, isReadOnly: boolean = false, documentDirUri: string = '', workspaceRelativePath: string = '') {
    this.document = document;
    this.webview = webview;
    this.isReadOnly = isReadOnly;
    this.documentDirUri = documentDirUri;
    this.workspaceRelativePath = workspaceRelativePath;
  }

  async handleWebviewMessage(msg: WebviewToExtensionMessage): Promise<void> {
    if (!this.isReadOnly && (msg.type === 'edit' || msg.type === 'save')) {
      this.isApplyingEdit = true;
    }
    this.messageQueue = this.messageQueue.then(() => this.processMessage(msg)).catch((err) => {
      console.error('[LiveMarkdown] messageQueue error:', err instanceof Error ? err.message : err);
    });
    return this.messageQueue;
  }

  private async processMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.originalContent = this.document.getText();
        this.postMessage({ type: 'init', markdown: this.document.getText(), isReadOnly: this.isReadOnly, documentDirUri: this.documentDirUri, workspaceRelativePath: this.workspaceRelativePath });
        break;

      case 'edit':
        if (this.isReadOnly) return;
        if (msg.version >= this.currentVersion) {
          await this.applyMarkdownEdit(msg.markdown);
        } else {
          this.isApplyingEdit = false;
        }
        break;

      case 'baseline':
        this.baselineContent = msg.markdown;
        break;

      case 'save':
        if (this.isReadOnly) return;
        await this.applyMarkdownEdit(msg.markdown);
        await this.document.save();
        break;

      case 'openFile': {
        const docDir = vscode.Uri.joinPath(this.document.uri, '..');
        const fileUri = vscode.Uri.joinPath(docDir, msg.src);
        vscode.commands.executeCommand('vscode.open', fileUri);
        break;
      }
    }
  }

  handleDocumentChange(document: vscode.TextDocument): void {
    if (this.isApplyingEdit) {
      return;
    }
    if (document.uri.toString() !== this.document.uri.toString()) {
      return;
    }

    const content = document.getText();
    if (this.lastAppliedContent !== null &&
        content.trimEnd() === this.lastAppliedContent.trimEnd()) {
      // keep lastAppliedContent for subsequent echoes
      return;
    }

    this.currentVersion++;
    this.postMessage({
      type: 'externalUpdate',
      markdown: content,
      version: this.currentVersion,
      documentDirUri: this.documentDirUri,
    });
    this.originalContent = content;
    this.baselineContent = null;
  }

  private async applyMarkdownEdit(markdown: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    let mergedContent: string | null = null;

    if (this.originalContent !== null && this.baselineContent !== null) {
      mergedContent = this.threeWayMerge(this.originalContent, this.baselineContent, markdown);
    }

    if (mergedContent !== null) {
      // Three-way merge succeeded — apply merged content
      const fullRange = new vscode.Range(0, 0, this.document.lineCount, 0);
      edit.replace(this.document.uri, fullRange, mergedContent);
    } else {
      // Fallback: full document replacement
      const fullRange = new vscode.Range(0, 0, this.document.lineCount, 0);
      edit.replace(this.document.uri, fullRange, markdown);
    }

    this.isApplyingEdit = true;
    await vscode.workspace.applyEdit(edit);
    this.currentVersion++;

    // Update all tracking from actual document state BEFORE releasing
    // the lock to prevent handleDocumentChange from sending spurious
    // externalUpdates. Use document.getText() (not contentToApply) so
    // lastAppliedContent matches exactly what VS Code stored, avoiding
    // mismatches from line-ending normalisation or trailing whitespace.
    const actualContent = this.document.getText();
    this.lastAppliedContent = actualContent;
    this.originalContent = actualContent;
    this.baselineContent = markdown;
    this.isApplyingEdit = false;
  }

  private threeWayMerge(original: string, baseline: string, edited: string): string | null {
    const baseLines = baseline.split('\n');
    const editLines = edited.split('\n');
    const origLines = original.split('\n');

    // Step 1: Find outer edit region (diff baseline vs edited)
    let editStart = 0;
    while (editStart < baseLines.length && editStart < editLines.length
           && baseLines[editStart] === editLines[editStart]) {
      editStart++;
    }

    let baseEnd = baseLines.length - 1;
    let editEnd = editLines.length - 1;
    while (baseEnd > editStart && editEnd > editStart
           && baseLines[baseEnd] === editLines[editEnd]) {
      baseEnd--;
      editEnd--;
    }

    // If nothing changed between baseline and edited, return original as-is
    if (editStart > baseEnd && editStart > editEnd) {
      return original;
    }

    // Step 2: Inner diff — separate truly new/changed content from shifted content.
    // When a user inserts a line, surrounding content shifts down but is unchanged.
    // Including that shifted content would duplicate it alongside the original.
    const baseEditRegion = baseLines.slice(editStart, baseEnd + 1);
    const editEditRegion = editLines.slice(editStart, editEnd + 1);

    let suffixLen = 0;
    while (suffixLen < baseEditRegion.length && suffixLen < editEditRegion.length
           && baseEditRegion[baseEditRegion.length - 1 - suffixLen] === editEditRegion[editEditRegion.length - 1 - suffixLen]) {
      suffixLen++;
    }

    let prefixLen = 0;
    const maxPrefix = Math.min(baseEditRegion.length, editEditRegion.length) - suffixLen;
    while (prefixLen < maxPrefix && baseEditRegion[prefixLen] === editEditRegion[prefixLen]) {
      prefixLen++;
    }

    const newContent = editEditRegion.slice(prefixLen, editEditRegion.length - suffixLen);
    const oldContent = baseEditRegion.slice(prefixLen, baseEditRegion.length - suffixLen);

    // Step 3: Build line mapping and find original positions
    const mapping = this.buildLineMapping(baseLines, origLines);
    const changeBaseStart = editStart + prefixLen;
    const changeBaseEnd = editStart + prefixLen + oldContent.length - 1;

    if (oldContent.length === 0) {
      // Pure insertion — find the insertion point in the original
      const insertAt = this.mapToOriginal(mapping, changeBaseStart, baseLines.length, origLines.length);
      if (insertAt < 0 || insertAt > origLines.length) return null;

      const result = [
        ...origLines.slice(0, insertAt),
        ...newContent,
        ...origLines.slice(insertAt),
      ];
      return result.join('\n');
    }

    // Replacement or deletion
    const origStart = this.mapToOriginal(mapping, changeBaseStart, baseLines.length, origLines.length);
    const origEnd = this.mapToOriginal(mapping, changeBaseEnd, baseLines.length, origLines.length);

    if (origStart < 0 || origEnd < 0 || origEnd < origStart || origStart > origLines.length || origEnd >= origLines.length) {
      return null;
    }

    const result = [
      ...origLines.slice(0, origStart),
      ...newContent,
      ...origLines.slice(origEnd + 1),
    ];

    return result.join('\n');
  }

  /**
   * Greedy alignment: walk both arrays matching identical lines.
   * When lines differ, use lookahead to find the next match.
   */
  private buildLineMapping(baseLines: string[], origLines: string[]): Map<number, number> {
    const mapping = new Map<number, number>();
    let b = 0, o = 0;

    while (b < baseLines.length && o < origLines.length) {
      if (baseLines[b] === origLines[o]) {
        mapping.set(b, o);
        b++;
        o++;
      } else {
        const LOOK = 15;
        let bestB = -1, bestO = -1, bestCost = Infinity;
        let bestIsContent = false;

        for (let db = 0; db < LOOK && b + db < baseLines.length; db++) {
          for (let dj = 0; dj < LOOK && o + dj < origLines.length; dj++) {
            if (baseLines[b + db] === origLines[o + dj]) {
              const rawCost = db + dj;
              const isContent = baseLines[b + db].trim() !== '';

              // Content-line matches anchor the alignment better than blank
              // lines, which repeat frequently and cause misalignment when
              // baseline diverges from original (e.g. HTML normalisation).
              let shouldUpdate = false;
              if (bestB === -1) {
                shouldUpdate = true;
              } else if (isContent && !bestIsContent) {
                shouldUpdate = true;
              } else if (isContent === bestIsContent && rawCost < bestCost) {
                shouldUpdate = true;
              }

              if (shouldUpdate) {
                bestB = b + db;
                bestO = o + dj;
                bestCost = rawCost;
                bestIsContent = isContent;
              }
              break;
            }
          }
          if (bestIsContent && bestCost <= db) break;
        }

        if (bestB !== -1) {
          b = bestB;
          o = bestO;
        } else {
          b++;
          o++;
        }
      }
    }

    return mapping;
  }

  /**
   * Translate a baseline line number to the corresponding original line number
   * using the sparse mapping. Interpolates between nearest mapped lines.
   */
  private mapToOriginal(mapping: Map<number, number>, baseLine: number, baseTotal: number, origTotal: number): number {
    if (mapping.has(baseLine)) return mapping.get(baseLine)!;

    // Find nearest mapped lines before and after
    let beforeBase = -1, beforeOrig = -1;
    for (let b = baseLine - 1; b >= 0; b--) {
      if (mapping.has(b)) {
        beforeBase = b;
        beforeOrig = mapping.get(b)!;
        break;
      }
    }

    let afterBase = -1, afterOrig = -1;
    for (let b = baseLine + 1; b < baseTotal; b++) {
      if (mapping.has(b)) {
        afterBase = b;
        afterOrig = mapping.get(b)!;
        break;
      }
    }

    if (beforeBase !== -1 && afterBase !== -1) {
      // Interpolate between the two mapped lines
      const fraction = (baseLine - beforeBase) / (afterBase - beforeBase);
      return Math.round(beforeOrig + fraction * (afterOrig - beforeOrig));
    } else if (beforeBase !== -1) {
      // Only before: offset forward
      return Math.min(beforeOrig + (baseLine - beforeBase), origTotal);
    } else if (afterBase !== -1) {
      // Only after: use the mapped line directly — don't offset backwards
      // because opaque regions (HTML blocks etc.) have very different line counts
      return afterOrig;
    }

    // No mapping at all
    return Math.min(Math.round(baseLine / baseTotal * origTotal), origTotal - 1);
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.webview.postMessage(message);
  }
}
