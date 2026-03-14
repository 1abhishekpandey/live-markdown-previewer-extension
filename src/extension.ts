import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function stripMarkdownSyntax(line: string): string {
	let text = line;
	// Strip blockquotes first (can wrap any block type)
	text = text.replace(/^[\s]*>[\s]?/g, '');
	// Detect heading — strip prefix but skip list/checkbox rules
	const headingMatch = text.match(/^#{1,6}\s+(.*)/);
	if (headingMatch) {
		text = headingMatch[1];
	} else {
		text = text
			.replace(/^[\s]*[-*+]\s+/, '')
			.replace(/^[\s]*\d+\.\s+/, '')
			.replace(/^[\s]*\[[ xX]\]\s*/, '');
	}
	// Strip inline formatting (applies to all block types)
	return text
		.replace(/\|/g, '')
		.replace(/\*\*([^*]*)\*\*/g, '$1')
		.replace(/__([^_]*)__/g, '$1')
		.replace(/\*([^*]*)\*/g, '$1')
		.replace(/_([^_]*)_/g, '$1')
		.replace(/~~(.*?)~~/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim();
}

export function findAnchorLine(
	document: vscode.TextDocument,
	anchorText: string,
	roughFraction: number
): number {
	const totalLines = document.lineCount;
	const candidates: number[] = [];
	for (let i = 0; i < totalLines; i++) {
		const stripped = stripMarkdownSyntax(document.lineAt(i).text);
		if (stripped === anchorText) {
			candidates.push(i);
		}
	}
	// If exact match failed, try prefix matching (first 30 chars)
	if (candidates.length === 0 && anchorText.length > 20) {
		const prefix = anchorText.substring(0, 30);
		for (let i = 0; i < totalLines; i++) {
			const stripped = stripMarkdownSyntax(document.lineAt(i).text);
			if (stripped.startsWith(prefix)) {
				candidates.push(i);
			}
		}
	}
	if (candidates.length === 0) {
		return Math.min(
			Math.max(0, Math.floor(roughFraction * totalLines)),
			Math.max(0, totalLines - 1)
		);
	}
	if (candidates.length === 1) return candidates[0];
	let best = candidates[0];
	let bestDiff = Infinity;
	for (const line of candidates) {
		const diff = Math.abs(line / totalLines - roughFraction);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = line;
		}
	}
	return best;
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new MarkdownEditorProvider(context);

	const disposable = vscode.window.registerCustomEditorProvider(
		'liveMarkdown.markdownEditor',
		provider,
		{ webviewOptions: { retainContextWhenHidden: true } }
	);

	// Debug: status bar showing top visible line in raw mode
	const debugStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
	debugStatus.name = 'Scroll Debug';
	const updateDebugStatus = (editor: vscode.TextEditor) => {
		if (editor.document.languageId === 'markdown') {
			const topLine = editor.visibleRanges[0]?.start.line ?? 0;
			const totalLines = editor.document.lineCount;
			const lineText = editor.document.lineAt(topLine).text;
			const truncated = lineText.length > 40 ? lineText.substring(0, 40) + '…' : lineText;
			debugStatus.text = `$(debug) L${topLine + 1} ${truncated}`;
		} else {
			debugStatus.text = '';
		}
	};
	const scrollDebugDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
		updateDebugStatus(e.textEditor);
	});
	const editorDebugDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor) updateDebugStatus(editor);
		else debugStatus.text = '';
	});

	// URIs the user explicitly toggled to raw mode — skip auto-switch for these
	const rawModeUris = new Set<string>();
	let isAutoSwitching = false;

	// Auto-open .md files with WYSIWYG unless in a diff or raw-mode toggle
	const autoOpenDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		if (isAutoSwitching || !editor) return;
		const doc = editor.document;
		if (doc.languageId !== 'markdown') return;
		if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;

		const uriStr = doc.uri.toString();
		if (rawModeUris.has(uriStr)) return;

		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (activeTab?.input instanceof vscode.TabInputTextDiff) return;

		isAutoSwitching = true;
		try {
			const uri = doc.uri;
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await vscode.commands.executeCommand(
				'vscode.openWith', uri, 'liveMarkdown.markdownEditor'
			);
		} finally {
			isAutoSwitching = false;
		}
	});

	// Clean up raw-mode tracking when tabs close
	const tabCloseDisposable = vscode.window.tabGroups.onDidChangeTabs((e) => {
		for (const tab of e.closed) {
			if (tab.input instanceof vscode.TabInputText) {
				rawModeUris.delete(tab.input.uri.toString());
			}
		}
	});

	const toggleCmd = vscode.commands.registerCommand(
		'liveMarkdown.toggleRawMarkdown',
		async () => {
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			if (!activeTab) return;

			const input = activeTab.input;

			if (input instanceof vscode.TabInputCustom
				&& input.viewType === 'liveMarkdown.markdownEditor') {
				// WYSIWYG → Raw
				const uri = input.uri;
				const docUri = uri.toString();

				const anchor = provider.getLastWebviewScrollAnchor(docUri);
				if (anchor) provider.storePendingRawAnchor(anchor);

				rawModeUris.add(docUri);
				isAutoSwitching = true;
				try {
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
					await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
				} finally {
					isAutoSwitching = false;
				}

				const rawAnchor = provider.consumePendingRawAnchor();
				if (rawAnchor) {
					const editor = vscode.window.activeTextEditor;
					if (editor) {
						const totalLines = editor.document.lineCount;
						const targetLine = rawAnchor.anchorText
							? findAnchorLine(editor.document, rawAnchor.anchorText, rawAnchor.roughFraction)
							: Math.min(
								Math.round(rawAnchor.roughFraction * Math.max(1, totalLines - 1)),
								Math.max(0, totalLines - 1)
							);
						// Reveal the target line, then compensate for sticky scroll headers.
						// revealRange(line, AtTop) puts the line below sticky headers,
						// but visibleRanges[0].start.line reports the viewport top (above sticky).
						// This asymmetry causes drift, so we overshoot by the measured offset.
						const revealWithCompensation = () => {
							const range = new vscode.Range(targetLine, 0, targetLine, 0);
							editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
							setTimeout(() => {
								const actual = editor.visibleRanges[0]?.start.line;
								if (actual !== undefined && actual < targetLine) {
									const adjusted = Math.min(
										targetLine + (targetLine - actual),
										Math.max(0, totalLines - 1)
									);
									editor.revealRange(
										new vscode.Range(adjusted, 0, adjusted, 0),
										vscode.TextEditorRevealType.AtTop
									);
								}
							}, 30);
						};
						let settleTimer: ReturnType<typeof setTimeout>;
						const disposable = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
							if (e.textEditor === editor) {
								clearTimeout(settleTimer);
								settleTimer = setTimeout(() => {
									disposable.dispose();
									revealWithCompensation();
								}, 100);
							}
						});
						settleTimer = setTimeout(() => {
							disposable.dispose();
							revealWithCompensation();
						}, 300);
						revealWithCompensation();
					}
				}
			} else if (input instanceof vscode.TabInputText) {
				// Raw → WYSIWYG
				const textEditor = vscode.window.activeTextEditor;
				if (!textEditor) return;

				const uri = textEditor.document.uri;
				const docUri = uri.toString();
				const topLine = textEditor.visibleRanges[0]?.start.line ?? 0;
				const totalLines = textEditor.document.lineCount;
				const roughFraction = totalLines > 1 ? topLine / (totalLines - 1) : 0;
				const topLineText = stripMarkdownSyntax(textEditor.document.lineAt(topLine).text);
				provider.setPendingPreviewAnchor(docUri, {
					anchorText: topLineText, lineIndex: topLine, totalLines,
					roughFraction,
				});

				rawModeUris.delete(docUri);
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				await vscode.commands.executeCommand(
					'vscode.openWith', uri, 'liveMarkdown.markdownEditor'
				);
			}
		}
	);

	context.subscriptions.push(disposable, autoOpenDisposable, tabCloseDisposable, toggleCmd, debugStatus, scrollDebugDisposable, editorDebugDisposable);
}

export function deactivate() {}
