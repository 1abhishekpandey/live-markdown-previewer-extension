import * as vscode from 'vscode';
import { MarkdownEditorProvider, isInDiffContext } from './markdownEditorProvider';

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
		const totalChars = document.getText().length;
		const charOffset = Math.min(
			Math.floor(roughFraction * totalChars),
			Math.max(0, totalChars - 1)
		);
		return document.positionAt(charOffset).line;
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

	// Track files the user has explicitly toggled to raw (text) mode via Shift+Cmd+M.
	// These are skipped by the auto-open listener so the user's choice is respected.
	const rawModeUris = new Set<string>();

	const toggleCmd = vscode.commands.registerCommand(
		'liveMarkdown.toggleRawMarkdown',
		async () => {
			const textEditor = vscode.window.activeTextEditor;
			const previewDocUri = textEditor?.document.uri.toString();

			if (textEditor && previewDocUri) {
				// Raw → Preview: extract anchor text from top visible line
				rawModeUris.delete(previewDocUri);
				const topLine = textEditor.visibleRanges[0]?.start.line ?? 0;
				const totalLines = textEditor.document.lineCount;
				let anchorText = '';
				for (let i = topLine; i < Math.min(topLine + 10, totalLines); i++) {
					const stripped = stripMarkdownSyntax(textEditor.document.lineAt(i).text);
					if (stripped.length > 0) {
						anchorText = stripped;
						break;
					}
				}
				if (anchorText) {
					provider.setPendingPreviewAnchor(previewDocUri, {
						anchorText,
						lineIndex: topLine,
						totalLines,
					});
				}
			} else {
				// Preview → Raw: read the last known webview scroll anchor
				const activeUri = provider.getActiveDocUri();
				if (activeUri) {
					rawModeUris.add(activeUri);
					const anchor = provider.getLastWebviewScrollAnchor(activeUri);
					if (anchor) {
						provider.storePendingRawAnchor(anchor);
					}
				}
			}

			await vscode.commands.executeCommand('workbench.action.toggleEditorType');

			// Preview → Raw: reveal the target line in the newly opened text editor
			const rawAnchor = provider.consumePendingRawAnchor();
			if (rawAnchor) {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					const targetLine = findAnchorLine(
						editor.document,
						rawAnchor.anchorText,
						rawAnchor.roughFraction
					);
					const range = new vscode.Range(targetLine, 0, targetLine, 0);
					editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
				}
			}
		}
	);

	// Auto-open .md files with the WYSIWYG editor when they are activated as a plain
	// text editor and are not in a diff context and not explicitly set to raw mode.
	// With priority "option", VS Code uses the text editor by default (which makes
	// Source Control diffs work natively). This listener upgrades to WYSIWYG for
	// normal editing.
	const autoOpenDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		if (!editor) return;
		const { document } = editor;
		if (!['file', 'untitled'].includes(document.uri.scheme)) return;
		if (document.languageId !== 'markdown') return;
		if (rawModeUris.has(document.uri.toString())) return;
		if (isInDiffContext(document.uri)) return;
		await vscode.commands.executeCommand('workbench.action.toggleEditorType');
	});

	context.subscriptions.push(disposable, toggleCmd, autoOpenDisposable);
}

export function deactivate() {}
