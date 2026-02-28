import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

function stripMarkdownSyntax(line: string): string {
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
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim();
}

function findAnchorLine(
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

	const toggleCmd = vscode.commands.registerCommand(
		'liveMarkdown.toggleRawMarkdown',
		async () => {
			const textEditor = vscode.window.activeTextEditor;
			const previewDocUri = textEditor?.document.uri.toString();

			if (textEditor && previewDocUri) {
				// Raw → Preview: extract anchor text from top visible line
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

	context.subscriptions.push(disposable, toggleCmd);
}

export function deactivate() {}
