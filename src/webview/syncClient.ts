import { Editor } from '@tiptap/core';
import { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../sync/syncProtocol';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export class SyncClient {
  private editor: Editor;
  private vscode: VsCodeApi;
  private isExternalUpdate: boolean = false;
  private currentVersion: number = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingExternalUpdate: ExtensionToWebviewMessage | null = null;
  // True once the first 'init' message has been handled and content is in the DOM.
  private isInitialized: boolean = false;
  // Buffered scroll anchor for when 'scrollToAnchor' arrives before 'init'.
  private pendingScrollAnchor: { anchorText: string; lineIndex: number; totalLines: number } | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private debounceDelayInMs: number = 300;
  private onFirstInit: (() => void) | undefined;
  private isReadOnly: boolean = false;

  constructor(editor: Editor, vscode: VsCodeApi, onFirstInit?: () => void) {
    this.editor = editor;
    this.vscode = vscode;
    this.onFirstInit = onFirstInit;
  }

  init(): void {
    this.editor.on('update', () => {
      if (this.isExternalUpdate) return;
      this.debouncedSendEdit();
    });

    this.setupKeyboardShortcuts();

    this.vscode.postMessage({ type: 'ready' });

    this.scrollTimer = null;

    window.addEventListener('scroll', () => {
      if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        const totalSize = this.editor.state.doc.content.size;
        const topPos = this.editor.view.posAtCoords({ left: 0, top: 0 });
        let anchorText = '';
        let roughFraction = 0;
        if (topPos && totalSize > 0) {
          const resolvedPos = this.editor.state.doc.resolve(topPos.pos);
          const depth = resolvedPos.depth;
          let blockNode;
          if (depth > 1) {
            blockNode = resolvedPos.node(1);
          } else {
            blockNode = resolvedPos.node(depth);
          }
          anchorText = blockNode.textContent.trim();
          roughFraction = topPos.pos / totalSize;
        } else {
          const scrollable = document.documentElement.scrollHeight - window.innerHeight;
          roughFraction = scrollable > 0 ? window.scrollY / scrollable : 0;
        }
        if (anchorText) {
          this.vscode.postMessage({
            type: 'scrollAnchorUpdate',
            anchorText,
            roughFraction: Math.max(0, Math.min(1, roughFraction)),
          });
        }
        this.scrollTimer = null;
      }, 150);
    }, { passive: true });
  }

  handleMessage(msg: ExtensionToWebviewMessage): void {
    switch (msg.type) {
      case 'init':
        this.editor.commands.setContent(msg.markdown);
        this.setAdaptiveDebounce(msg.markdown.length);
        if (msg.isReadOnly) {
          this.isReadOnly = true;
          this.editor.setEditable(false);
          this.insertReadOnlyBanner();
        }
        if (this.onFirstInit) {
          this.onFirstInit();
          this.onFirstInit = undefined;
        }
        this.isInitialized = true;
        if (this.pendingScrollAnchor !== null) {
          const anchor = this.pendingScrollAnchor;
          this.pendingScrollAnchor = null;
          requestAnimationFrame(() => this.applyScrollAnchor(anchor));
        }
        break;

      case 'scrollToAnchor': {
        if (!this.isInitialized) {
          this.pendingScrollAnchor = { anchorText: msg.anchorText, lineIndex: msg.lineIndex, totalLines: msg.totalLines };
        } else {
          const anchor = { anchorText: msg.anchorText, lineIndex: msg.lineIndex, totalLines: msg.totalLines };
          requestAnimationFrame(() => this.applyScrollAnchor(anchor));
        }
        break;
      }

      case 'externalUpdate': {
        if (msg.version <= this.currentVersion) return;

        if (this.debounceTimer !== null) {
          this.pendingExternalUpdate = msg;
          break;
        }

        this.applyExternalUpdate(msg);
        break;
      }
    }
  }

  private applyScrollAnchor(
    anchor: { anchorText: string; lineIndex: number; totalLines: number },
    retriesLeft: number = 5
  ): void {
    const doc = this.editor.state.doc;
    const totalSize = doc.content.size;
    const candidates: { pos: number; offset: number }[] = [];

    doc.forEach((node, offset) => {
      const text = node.textContent.trim();
      if (text === anchor.anchorText) {
        candidates.push({ pos: offset + 1, offset });
      }
    });

    // If exact match failed, try prefix matching
    if (candidates.length === 0 && anchor.anchorText.length > 20) {
      const prefix = anchor.anchorText.substring(0, 30);
      doc.forEach((node, offset) => {
        const text = node.textContent.trim();
        if (text.startsWith(prefix)) {
          candidates.push({ pos: offset + 1, offset });
        }
      });
    }

    let targetPos: number;
    if (candidates.length === 0) {
      const roughFraction = anchor.totalLines > 0 ? anchor.lineIndex / anchor.totalLines : 0;
      targetPos = Math.min(Math.floor(roughFraction * totalSize), Math.max(0, totalSize - 1));
    } else if (candidates.length === 1) {
      targetPos = candidates[0].pos;
    } else {
      const expectedFraction = anchor.totalLines > 0 ? anchor.lineIndex / anchor.totalLines : 0;
      let best = candidates[0];
      let bestDiff = Infinity;
      for (const c of candidates) {
        const nodeFraction = c.offset / totalSize;
        const diff = Math.abs(nodeFraction - expectedFraction);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }
      targetPos = best.pos;
    }

    try {
      const coords = this.editor.view.coordsAtPos(targetPos);
      window.scrollTo({ top: coords.top + window.scrollY, behavior: 'instant' as ScrollBehavior });
    } catch {
      if (retriesLeft > 0) {
        setTimeout(() => this.applyScrollAnchor(anchor, retriesLeft - 1), 50);
        return;
      }
      const roughFraction = anchor.totalLines > 0 ? anchor.lineIndex / anchor.totalLines : 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: roughFraction * Math.max(0, scrollable) });
    }
  }

  private setAdaptiveDebounce(charCount: number): void {
    if (charCount > 100_000) {
      this.debounceDelayInMs = 800;
    } else if (charCount > 30_000) {
      this.debounceDelayInMs = 500;
    } else {
      this.debounceDelayInMs = 300;
    }
  }

  private debouncedSendEdit(): void {
    if (this.isReadOnly) return;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.sendEdit();
    }, this.debounceDelayInMs);
  }

  private applyExternalUpdate(msg: ExtensionToWebviewMessage): void {
    if (msg.type !== 'externalUpdate') return;

    const currentMarkdown = this.editor.storage.markdown.getMarkdown();
    if (msg.markdown.trimEnd() === currentMarkdown.trimEnd()) {
      this.currentVersion = msg.version;
      return;
    }

    this.isExternalUpdate = true;

    const { from, to } = this.editor.state.selection;

    this.editor.commands.setContent(msg.markdown);

    this.editor.commands.setTextSelection({
      from: Math.min(from, this.editor.state.doc.content.size - 1),
      to: Math.min(to, this.editor.state.doc.content.size - 1),
    });

    this.currentVersion = msg.version;
    this.isExternalUpdate = false;
  }

  private sendEdit(): void {
    const markdown = this.editor.storage.markdown.getMarkdown();
    this.currentVersion++;
    this.vscode.postMessage({ type: 'edit', markdown, version: this.currentVersion });

    if (this.pendingExternalUpdate) {
      const pending = this.pendingExternalUpdate;
      this.pendingExternalUpdate = null;
      this.applyExternalUpdate(pending);
    }
  }

  private setupKeyboardShortcuts(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.id === 'search-input') return;

      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (!this.isReadOnly) this.vscode.postMessage({ type: 'undo' });
      } else if (e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        if (!this.isReadOnly) this.vscode.postMessage({ type: 'redo' });
      } else if (e.key === 's') {
        e.preventDefault();
        if (!this.isReadOnly) {
          const markdown = this.editor.storage.markdown.getMarkdown();
          this.vscode.postMessage({ type: 'save', markdown });
        }
      }
    };

    document.addEventListener('keydown', this.keydownHandler);
  }

  private insertReadOnlyBanner(): void {
    const banner = document.createElement('div');
    banner.id = 'read-only-banner';
    banner.textContent = 'Read-only';
    document.body.insertBefore(banner, document.body.firstChild);
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.scrollTimer !== null) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }

    this.pendingScrollAnchor = null;

    if (this.keydownHandler !== null) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }
}
