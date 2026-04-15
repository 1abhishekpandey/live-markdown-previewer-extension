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
          clipboardTextSerializer: (slice) => {
            if (!copyModeRaw) {
              return undefined as unknown as string;
            }
            const doc = editor.schema.topNodeType.create(null, slice.content);
            const raw = editor.storage.markdown.serializer.serialize(doc);
            const result = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
            return result;
          },
        },
      }),
    ];
  },
});
