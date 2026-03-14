import './styles.css';
import { createEditor } from './editor';
import { SyncClient } from './syncClient';
import { setCopyMode } from './copyToolbar';
import type { ExtensionToWebviewMessage } from '../sync/syncProtocol';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const editorElement = document.getElementById('editor');
if (!editorElement) {
  throw new Error('Editor element not found');
}

const editor = createEditor(editorElement);
const loadingOverlay = document.getElementById('loading-overlay');
const safetyTimeout = setTimeout(() => {
  loadingOverlay?.classList.add('hidden');
}, 8000);

const syncClient = new SyncClient(editor, vscode, () => {
  clearTimeout(safetyTimeout);
  loadingOverlay?.classList.add('hidden');
});

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || typeof data.type !== 'string') return;
  if (data.type === 'debugLineInfo') {
    syncClient.updateDebugOverlay(data.lineNum, data.lineText);
    return;
  }
  syncClient.handleMessage(data as ExtensionToWebviewMessage);
});

// Code wrap toggle
const state = vscode.getState() as { codeWrap?: boolean } | null;
let codeWrap = state?.codeWrap ?? false;

const toggle = document.createElement('button');
toggle.className = 'code-wrap-toggle';
toggle.textContent = codeWrap ? 'Wrap: On' : 'Wrap: Off';
document.body.appendChild(toggle);

if (codeWrap) {
  editorElement.classList.add('code-wrap');
}

toggle.addEventListener('click', () => {
  codeWrap = !codeWrap;
  editorElement.classList.toggle('code-wrap', codeWrap);
  toggle.textContent = codeWrap ? 'Wrap: On' : 'Wrap: Off';
  vscode.setState({ ...((vscode.getState() as object) ?? {}), codeWrap });
});

// Copy mode toggle
let copyModeRaw = true;
setCopyMode(copyModeRaw);

const copyToggle = document.createElement('button');
copyToggle.className = 'copy-mode-toggle';
copyToggle.textContent = copyModeRaw ? 'Copy: Raw' : 'Copy: Rich';
copyToggle.title = copyModeRaw ? 'Copy mode: Raw Markdown' : 'Copy mode: Rendered';
document.body.appendChild(copyToggle);

copyToggle.addEventListener('click', () => {
  copyModeRaw = !copyModeRaw;
  setCopyMode(copyModeRaw);
  copyToggle.textContent = copyModeRaw ? 'Copy: Raw' : 'Copy: Rich';
  copyToggle.title = copyModeRaw ? 'Copy mode: Raw Markdown' : 'Copy mode: Rendered';
});

syncClient.init();
