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
  // scrollTimer removed — rAF throttle replaces debounce for anchor updates
  private pendingExternalUpdate: ExtensionToWebviewMessage | null = null;
  // True once the first 'init' message has been handled and content is in the DOM.
  private isInitialized: boolean = false;
  // Buffered scroll anchor for when 'scrollToAnchor' arrives before 'init'.
  private pendingScrollAnchor: { anchorText: string; lineIndex: number; totalLines: number; roughFraction?: number } | null = null;
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

    // Use rAF throttle instead of debounce — ensures cached anchor is always
    // within ~16ms of the current scroll position (critical for toggle sync)
    let scrollRAFPending = false;
    window.addEventListener('scroll', () => {
      if (!scrollRAFPending) {
        scrollRAFPending = true;
        requestAnimationFrame(() => {
          this.computeAndSendAnchor();
          scrollRAFPending = false;
        });
      }
    }, { passive: true });
  }

  private computeAndSendAnchor(): void {
    let anchorText = '';
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const roughFraction = scrollable > 0 ? window.scrollY / scrollable : 0;

    // Find the first visible block element (DOM order = visual order)
    const editorEl = this.editor.view && this.editor.view.dom;
    if (!editorEl) {
      this.vscode.postMessage({
        type: 'scrollAnchorUpdate',
        anchorText: '',
        roughFraction: Math.max(0, Math.min(1, roughFraction)),
      });
      return;
    }
    const allBlocks = editorEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, th, td');
    let bestEl: Element | null = null;
    for (const el of Array.from(allBlocks)) {
      let measureEl: Element = el;
      if (el.tagName === 'LI' && el.querySelector(':scope > ul, :scope > ol')) {
        const directP = el.querySelector(':scope > p');
        if (directP) {
          measureEl = directP;
        } else {
          continue;
        }
      }
      if (el.tagName === 'P' && el.parentElement?.tagName === 'LI') continue;
      const rect = measureEl.getBoundingClientRect();
      if (rect.bottom <= 5) continue; // skip elements with <5px visible (prevents drift)
      if (rect.top >= window.innerHeight) break;
      bestEl = el;
      break;
    }
    if (bestEl) {
      anchorText = this.extractElementText(bestEl);
    }
    this.vscode.postMessage({
      type: 'scrollAnchorUpdate',
      anchorText,
      roughFraction: Math.max(0, Math.min(1, roughFraction)),
    });
  }

  private extractElementText(el: Element): string {
    if (el.tagName === 'TH' || el.tagName === 'TD') {
      const tr = el.closest('tr');
      if (tr) {
        const cells = tr.querySelectorAll('th, td');
        return Array.from(cells).map(c => c.textContent?.trim() ?? '').join('  ').trim();
      }
    }
    if (el.tagName === 'LI') {
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
    }
    if (el.tagName === 'PRE') {
      const codeEl = el.querySelector('code');
      const codeText = (codeEl ?? el).textContent ?? '';
      const codeLines = codeText.split('\n');
      const preRect = el.getBoundingClientRect();
      if (preRect.top >= 0) {
        return codeLines.find(l => l.trim().length > 0)?.trim() ?? '';
      }
      const lineHeight = preRect.height / Math.max(codeLines.length, 1);
      const linesScrolled = Math.floor(Math.abs(preRect.top) / lineHeight);
      const idx = Math.min(linesScrolled, codeLines.length - 1);
      for (let i = idx; i < codeLines.length; i++) {
        if (codeLines[i].trim().length > 0) {
          return codeLines[i].trim();
        }
      }
      return '';
    }
    return el.textContent?.trim() ?? '';
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
        } else {
          // Send initial anchor so the extension always has a cached position
          requestAnimationFrame(() => this.computeAndSendAnchor());
        }
        break;

      case 'scrollToAnchor': {
        const anchor = {
          anchorText: msg.anchorText, lineIndex: msg.lineIndex, totalLines: msg.totalLines,
          roughFraction: msg.roughFraction,
        };
        if (!this.isInitialized) {
          this.pendingScrollAnchor = anchor;
        } else {
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
    anchor: { anchorText: string; lineIndex: number; totalLines: number; roughFraction?: number },
    retriesLeft: number = 5
  ): void {
    const fraction = anchor.roughFraction != null
      ? anchor.roughFraction
      : (anchor.totalLines > 1 ? anchor.lineIndex / (anchor.totalLines - 1) : 0);
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return;

    // Try DOM text matching first (same coordinate system as detection)
    if (anchor.anchorText) {
      const match = this.findElementByText(anchor.anchorText, fraction);
      if (match) {
        const targetScrollY = match.measureEl.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
        if (retriesLeft > 0 && Math.abs(window.scrollY - targetScrollY) > 10) {
          setTimeout(() => this.applyScrollAnchor(anchor, retriesLeft - 1), 50);
        }
        return;
      }
    }

    // Fallback: percentage-based scroll
    const targetScrollY = fraction * scrollable;
    window.scrollTo({ top: targetScrollY, behavior: 'instant' as ScrollBehavior });
    if (retriesLeft > 0 && Math.abs(window.scrollY - targetScrollY) > 10) {
      setTimeout(() => this.applyScrollAnchor(anchor, retriesLeft - 1), 50);
    }
  }

  private findElementByText(
    anchorText: string,
    roughFraction: number
  ): { element: Element; measureEl: Element } | null {
    const editorEl = this.editor.view && this.editor.view.dom;
    if (!editorEl || !anchorText) return null;

    const allBlocks = editorEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre, th, td');
    const candidates: { element: Element; measureEl: Element; index: number }[] = [];

    const seenRows = new Set<Element>();
    let idx = 0;
    for (const el of Array.from(allBlocks)) {
      if (el.tagName === 'P' && el.parentElement?.tagName === 'LI') continue;

      // For table cells, only process the first cell per row (all cells return the same row text)
      if (el.tagName === 'TH' || el.tagName === 'TD') {
        const tr = el.closest('tr');
        if (tr) {
          if (seenRows.has(tr)) { idx++; continue; }
          seenRows.add(tr);
        }
      }

      let measureEl: Element = el;
      if (el.tagName === 'LI' && el.querySelector(':scope > ul, :scope > ol')) {
        const directP = el.querySelector(':scope > p');
        if (directP) {
          measureEl = directP;
        } else {
          idx++;
          continue;
        }
      }

      const text = this.extractElementText(el);
      if (text === anchorText) {
        candidates.push({ element: el, measureEl, index: idx });
      }
      idx++;
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Disambiguate using position fraction
    const totalBlocks = allBlocks.length;
    let best = candidates[0];
    let bestDiff = Infinity;
    for (const c of candidates) {
      const posFraction = totalBlocks > 1 ? c.index / (totalBlocks - 1) : 0;
      const diff = Math.abs(posFraction - roughFraction);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
    return best;
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

    this.pendingScrollAnchor = null;

    if (this.keydownHandler !== null) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }
}
