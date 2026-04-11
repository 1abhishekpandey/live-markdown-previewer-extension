import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    llmComment: {
      setLlmComment: (attrs: { commentId: string }) => ReturnType;
      unsetLlmCommentById: (id: string) => ReturnType;
      clearAllLlmComments: () => ReturnType;
    };
  }
}

export const LlmCommentMark = Mark.create({
  name: 'llmComment',
  excludes: '', // allow stacking of multiple llmComment marks on the same range
  inclusive: false, // typing at the edge does not extend the mark

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-llm-comment-id'),
        renderHTML: (attrs: Record<string, unknown>) => {
          if (attrs.commentId == null) return {};
          return { 'data-llm-comment-id': attrs.commentId as string };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-llm-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ class: 'llm-comment-mark' }, HTMLAttributes),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '',
          close: '',
          mixable: true,
          expelEnclosingWhitespace: false,
        },
      },
    };
  },

  addCommands() {
    return {
      setLlmComment:
        (attrs) =>
        ({ commands }) => {
          return commands.setMark(this.name, attrs);
        },

      unsetLlmCommentById:
        (id) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks[this.name];
          if (!markType) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const mark of node.marks) {
              if (
                mark.type === markType &&
                (mark.attrs as { commentId?: string }).commentId === id
              ) {
                tr.removeMark(pos, pos + node.nodeSize, mark);
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },

      clearAllLlmComments:
        () =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks[this.name];
          if (!markType) return false;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const mark of node.marks) {
              if (mark.type === markType) {
                tr.removeMark(pos, pos + node.nodeSize, mark);
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
});
