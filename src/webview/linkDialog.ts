import { Editor, Extension } from '@tiptap/core';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'mailto:']);

function isSafeUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

let activeOverlay: HTMLDivElement | null = null;

function getExistingLinkUrl(editor: Editor): string {
  const attrs = editor.getAttributes('link');
  return attrs.href ?? '';
}

function positionOverlay(overlay: HTMLDivElement, editor: Editor): void {
  const { view } = editor;
  const { from, to } = view.state.selection;
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);

  if (start && end) {
    const midX = (start.left + end.right) / 2;
    const bottomY = Math.max(start.bottom, end.bottom);
    overlay.style.left = `${midX - 150}px`;
    overlay.style.top = `${bottomY + 8}px`;
  } else {
    const editorRect = view.dom.getBoundingClientRect();
    overlay.style.left = `${editorRect.left + editorRect.width / 2 - 150}px`;
    overlay.style.top = `${editorRect.top + editorRect.height / 2}px`;
  }
}

function hideOverlay(editor: Editor): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  editor.commands.focus();
}

export function showLinkDialog(editor: Editor): void {
  if (activeOverlay) {
    hideOverlay(editor);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'link-dialog-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    padding: '8px',
    borderRadius: '4px',
    zIndex: '1000',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
  });

  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'Enter URL...';
  Object.assign(input.style, {
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    border: 'none',
    outline: 'none',
    width: '300px',
    fontSize: '14px',
  });

  const existingUrl = getExistingLinkUrl(editor);
  if (existingUrl) {
    input.value = existingUrl;
  }

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const url = input.value.trim();
      if (url) {
        if (!isSafeUrl(url)) return;
        editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
      } else {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
      }
      hideOverlay(editor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideOverlay(editor);
    }
  });

  overlay.appendChild(input);
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  positionOverlay(overlay, editor);
  input.focus();
  input.select();
}

export function createLinkDialog(editor: Editor): () => void {
  return () => {
    if (activeOverlay) {
      hideOverlay(editor);
    }
  };
}

export const LinkDialogExtension = Extension.create({
  name: 'linkDialog',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        showLinkDialog(this.editor);
        return true;
      },
    };
  },
});
