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

    document.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG') {
        const src = target.getAttribute('data-src');
        if (src) {
          this.vscode.postMessage({ type: 'openFile', src });
        }
      }
    });

    document.addEventListener('click', (e) => {
      const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || /^[a-z][a-z\d+\-.]*:/i.test(href)) return;
      e.preventDefault();
      this.vscode.postMessage({ type: 'openFile', src: href });
    });

    this.vscode.postMessage({ type: 'ready' });

    this.scrollTimer = null;

    window.addEventListener('scroll', () => {
      if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        let anchorText = '';
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        const roughFraction = scrollable > 0 ? window.scrollY / scrollable : 0;

        // Find the block element closest to the top of the viewport
        const editorEl = this.editor.view.dom;
        const allBlocks = editorEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, th, td');
        let bestEl: Element | null = null;
        let bestTop = Infinity;
        for (const el of Array.from(allBlocks)) {
          // For LI with nested lists, use its direct P child's rect for positioning
          let measureEl: Element = el;
          if (el.tagName === 'LI' && el.querySelector(':scope > ul, :scope > ol')) {
            const directP = el.querySelector(':scope > p');
            if (directP) {
              measureEl = directP;
            } else {
              // No direct P — skip this parent LI, its children (leaf LIs) will match
              continue;
            }
          }
          // Skip P inside LI — the LI handles its own text extraction
          if (el.tagName === 'P' && el.parentElement?.tagName === 'LI') continue;
          const rect = measureEl.getBoundingClientRect();
          if (rect.bottom <= 0) continue;
          if (rect.top >= window.innerHeight) break;
          const dist = Math.abs(rect.top);
          if (dist < bestTop) {
            bestTop = dist;
            bestEl = el;
          }
        }
        if (bestEl) {
          // Extract direct text only (excluding nested UL/OL children)
          const extractDirectText = (el: Element): string => {
            const directP = el.querySelector(':scope > p');
            if (directP) return directP.textContent?.trim() ?? '';
            let text = '';
            for (const child of Array.from(el.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent;
              } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = (child as Element).tagName;
                if (!['UL', 'OL'].includes(tag)) {
                  text += (child as Element).textContent;
                }
              }
            }
            return text.trim();
          };
          if (bestEl.tagName === 'LI') {
            anchorText = extractDirectText(bestEl);
          } else {
            anchorText = bestEl.textContent?.trim() ?? '';
          }
        }
        this.vscode.postMessage({
          type: 'scrollAnchorUpdate',
          anchorText,
          roughFraction: Math.max(0, Math.min(1, roughFraction)),
        });
        // Line number is computed by the extension via debugLineInfo message
        this.scrollTimer = null;
      }, 150);
    }, { passive: true });
  }

  handleMessage(msg: ExtensionToWebviewMessage): void {
    switch (msg.type) {
      case 'init':
        if (msg.documentDirUri) {
          this.editor.storage.localImage.documentDirUri = msg.documentDirUri;
        }
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
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: roughFraction * Math.max(0, scrollable), behavior: 'instant' as ScrollBehavior });
      return;
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

    if (msg.documentDirUri) {
      this.editor.storage.localImage.documentDirUri = msg.documentDirUri;
    }
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

  updateDebugOverlay(lineNum: number, lineText: string): void {
    let overlay = document.getElementById('scroll-debug-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'scroll-debug-overlay';
      overlay.style.cssText = 'position:fixed;top:4px;right:4px;background:rgba(0,0,0,0.85);color:#0f0;font:13px/1.3 monospace;padding:6px 10px;border-radius:4px;z-index:99999;max-width:400px;pointer-events:none;';
      document.body.appendChild(overlay);
    }
    const truncated = lineText.length > 50 ? lineText.substring(0, 50) + '…' : lineText;
    overlay.textContent = `L${lineNum} ${truncated}`;
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
