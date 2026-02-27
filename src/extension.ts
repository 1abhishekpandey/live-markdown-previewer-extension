import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
	const provider = new MarkdownEditorProvider(context);

	const disposable = vscode.window.registerCustomEditorProvider(
		'mdEditor.markdownEditor',
		provider,
		{ webviewOptions: { retainContextWhenHidden: true } }
	);

	const toggleCmd = vscode.commands.registerCommand(
		'mdEditor.toggleRawMarkdown',
		() => vscode.commands.executeCommand('workbench.action.toggleEditorType')
	);

	context.subscriptions.push(disposable, toggleCmd);
}

export function deactivate() {}
