import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

let copyModeRaw = true;

export function setCopyMode(raw: boolean): void {
  copyModeRaw = raw;
}

export function getCopyMode(): boolean {
  return copyModeRaw;
}

export const CopyToolbarExtension = Extension.create({
  name: 'copyToolbar',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('copyToolbar'),
        props: {
          handleDOMEvents: {
            copy: (view, event: ClipboardEvent) => {
              if (!copyModeRaw) return false;

              const { from, to } = view.state.selection;
              if (from === to) return false;

              event.preventDefault();
              const slice = view.state.doc.slice(from, to);
              const markdown = editor.storage.markdown.serializer.serialize(slice.content);
              event.clipboardData?.setData('text/plain', markdown);
              return true;
            },
          },
        },
      }),
    ];
  },
});
