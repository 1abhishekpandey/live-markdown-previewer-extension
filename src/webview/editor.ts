import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import { LinkDialogExtension } from './linkDialog';
import { SearchBarExtension } from './searchBar';
import { GfmAlertExtension } from './gfmAlert';
import { CopyToolbarExtension } from './copyToolbar';

const lowlight = createLowlight(common);

const DANGEROUS_PROTOCOLS = /^\s*(javascript|data|vbscript):/i;

function isAllowedLinkUri(
  url: string,
  ctx: { defaultValidate: (url: string) => boolean },
): boolean {
  if (!url) return false;
  if (DANGEROUS_PROTOCOLS.test(url)) return false;
  // Default validation rejects relative paths like "docs/setup.md"
  // due to a regex bug where '/' falls in the ASCII range '.-:'.
  // Allow any URL that isn't a dangerous protocol.
  return true;
}

const CustomCodeBlock = CodeBlockLowlight.configure({ lowlight }).extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: any, node: any) {
          state.write("```" + (node.attrs.language || "") + "\n");
          state.text(node.textContent, false);
          // ensureNewLine() is a no-op when output already ends with \n,
          // which absorbs trailing empty lines in code blocks.
          // Add an explicit \n when content has a trailing newline so it
          // survives the fenced code round-trip.
          if (node.textContent.endsWith("\n")) {
            state.out += "\n";
          }
          state.ensureNewLine();
          state.write("```");
          state.closeBlock(node);
        },
      },
    };
  },
});

export function createEditor(element: HTMLElement): Editor {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        history: false,
        codeBlock: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'editor-link' },
        isAllowedUri: isAllowedLinkUri,
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        transformPastedText: true,
        transformCopiedText: false,
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      CustomCodeBlock,
      LinkDialogExtension,
      SearchBarExtension,
      GfmAlertExtension,
      CopyToolbarExtension,
    ],
    editorProps: {
      attributes: {
        class: 'md-editor-content',
        spellcheck: 'true',
      },
    },
  });
}
