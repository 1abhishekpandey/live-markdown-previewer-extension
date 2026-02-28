import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';

const ALERT_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;
const gfmAlertPluginKey = new PluginKey('gfmAlert');

export const GfmAlertExtension = Extension.create({
  name: 'gfmAlert',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: gfmAlertPluginKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node: PmNode, pos: number) => {
              if (node.type.name !== 'blockquote') return;
              const firstChild = node.firstChild;
              if (!firstChild || firstChild.type.name !== 'paragraph') return;
              const match = firstChild.textContent.trim().match(ALERT_PATTERN);
              if (!match) return;
              const type = match[1].toLowerCase();
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: `gfm-alert gfm-alert-${type}`,
                })
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
