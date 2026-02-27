import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
	const provider = new MarkdownEditorProvider(context);

	const disposable = vscode.window.registerCustomEditorProvider(
		'mdEditor.markdownEditor',
		provider,
		{ webviewOptions: { retainContextWhenHidden: true } }
	);

	context.subscriptions.push(disposable);
}

export function deactivate() {}
