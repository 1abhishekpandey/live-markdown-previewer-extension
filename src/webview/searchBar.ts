import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';

interface SearchMatch {
  from: number;
  to: number;
}

interface SearchState {
  query: string;
  matches: SearchMatch[];
  activeIndex: number;
  decorations: DecorationSet;
}

const searchPluginKey = new PluginKey<SearchState>('searchBar');

function findMatches(doc: PmNode, query: string): SearchMatch[] {
  if (!query) return [];

  const matches: SearchMatch[] = [];
  const lowerQuery = query.toLowerCase();

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const text = node.text.toLowerCase();
    let index = text.indexOf(lowerQuery);
    while (index !== -1) {
      matches.push({ from: pos + index, to: pos + index + query.length });
      index = text.indexOf(lowerQuery, index + 1);
    }
  });

  return matches;
}

function buildDecorations(
  doc: PmNode,
  matches: SearchMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;

  const decorations = matches.map((match, i) => {
    const className = i === activeIndex ? 'search-match-active' : 'search-match';
    return Decoration.inline(match.from, match.to, { class: className });
  });

  return DecorationSet.create(doc, decorations);
}

function createSearchPlugin(): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key: searchPluginKey,
    state: {
      init(): SearchState {
        return {
          query: '',
          matches: [],
          activeIndex: -1,
          decorations: DecorationSet.empty,
        };
      },
      apply(tr, prev): SearchState {
        const meta = tr.getMeta(searchPluginKey) as
          | { query: string; activeIndex?: number }
          | { activeIndex: number }
          | { clear: true }
          | undefined;

        if (meta && 'clear' in meta) {
          return {
            query: '',
            matches: [],
            activeIndex: -1,
            decorations: DecorationSet.empty,
          };
        }

        if (meta && 'query' in meta) {
          const query = meta.query;
          const matches = findMatches(tr.doc, query);
          const activeIndex =
            'activeIndex' in meta && meta.activeIndex !== undefined
              ? meta.activeIndex
              : matches.length > 0
                ? 0
                : -1;
          return {
            query,
            matches,
            activeIndex,
            decorations: buildDecorations(tr.doc, matches, activeIndex),
          };
        }

        if (meta && 'activeIndex' in meta) {
          const activeIndex = meta.activeIndex;
          return {
            ...prev,
            activeIndex,
            decorations: buildDecorations(tr.doc, prev.matches, activeIndex),
          };
        }

        if (tr.docChanged && prev.query) {
          const matches = findMatches(tr.doc, prev.query);
          const activeIndex = matches.length > 0
            ? Math.min(prev.activeIndex, matches.length - 1)
            : -1;
          return {
            ...prev,
            matches,
            activeIndex: Math.max(activeIndex, 0),
            decorations: buildDecorations(
              tr.doc,
              matches,
              Math.max(activeIndex, 0)
            ),
          };
        }

        return prev;
      },
    },
    props: {
      decorations(state) {
        return searchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

// --- DOM Overlay ---

let activeSearchBar: HTMLDivElement | null = null;

function dispatchSearch(editor: Editor, query: string, activeIndex?: number): void {
  const tr = editor.view.state.tr.setMeta(searchPluginKey, { query, activeIndex });
  editor.view.dispatch(tr);
}

function dispatchActiveIndex(editor: Editor, activeIndex: number): void {
  const tr = editor.view.state.tr.setMeta(searchPluginKey, { activeIndex });
  editor.view.dispatch(tr);
}

function dispatchClear(editor: Editor): void {
  const tr = editor.view.state.tr.setMeta(searchPluginKey, { clear: true });
  editor.view.dispatch(tr);
}

function scrollToMatch(editor: Editor, match: SearchMatch): void {
  const tr = editor.view.state.tr;
  const selection = TextSelection.create(tr.doc, match.from, match.to);
  editor.view.dispatch(tr.setSelection(selection).scrollIntoView());

  // ProseMirror's scrollIntoView can be unreliable for distant matches.
  // Use coordsAtPos as a fallback to ensure the match is visible.
  requestAnimationFrame(() => {
    try {
      const coords = editor.view.coordsAtPos(match.from);
      const viewportTop = window.scrollY;
      const viewportBottom = viewportTop + window.innerHeight;
      const margin = 100;

      if (coords.top < viewportTop + margin || coords.bottom > viewportBottom - margin) {
        window.scrollTo({
          top: coords.top + window.scrollY - window.innerHeight / 3,
          behavior: 'smooth',
        });
      }
    } catch {
      // coordsAtPos can throw for invalid positions; scrollIntoView is the fallback
    }
  });
}

function navigateMatch(
  editor: Editor,
  direction: 'next' | 'prev',
  countEl: HTMLSpanElement
): void {
  const state = getSearchState(editor);
  if (!state || state.matches.length === 0) return;

  const nextIndex = direction === 'next'
    ? (state.activeIndex + 1) % state.matches.length
    : (state.activeIndex - 1 + state.matches.length) % state.matches.length;

  dispatchActiveIndex(editor, nextIndex);
  updateCountLabel(countEl, getSearchState(editor));
  scrollToMatch(editor, state.matches[nextIndex]);
}

function getSearchState(editor: Editor): SearchState | undefined {
  return searchPluginKey.getState(editor.view.state);
}

function updateCountLabel(countEl: HTMLSpanElement, state: SearchState | undefined): void {
  if (!state || state.matches.length === 0) {
    countEl.textContent = state?.query ? 'No results' : '';
  } else {
    countEl.textContent = `${state.activeIndex + 1}/${state.matches.length}`;
  }
}

export function closeSearchBar(editor: Editor): void {
  if (activeSearchBar) {
    activeSearchBar.remove();
    activeSearchBar = null;
    dispatchClear(editor);
    editor.commands.focus();
  }
}

export function openSearchBar(editor: Editor): void {
  if (activeSearchBar) {
    const input = activeSearchBar.querySelector('#search-input') as HTMLInputElement | null;
    input?.focus();
    input?.select();
    return;
  }

  const bar = document.createElement('div');
  bar.id = 'search-bar';

  const input = document.createElement('input');
  input.id = 'search-input';
  input.type = 'text';
  input.placeholder = 'Find…';

  const count = document.createElement('span');
  count.id = 'search-count';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'search-nav-btn';
  prevBtn.textContent = '↑';
  prevBtn.title = 'Previous match (Shift+Enter)';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'search-nav-btn';
  nextBtn.textContent = '↓';
  nextBtn.title = 'Next match (Enter)';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'search-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Escape)';

  bar.appendChild(input);
  bar.appendChild(count);
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(closeBtn);
  document.body.appendChild(bar);
  activeSearchBar = bar;

  // Pre-fill with selection
  const { from, to } = editor.view.state.selection;
  if (from !== to) {
    const selectedText = editor.view.state.doc.textBetween(from, to, ' ');
    if (selectedText.length > 0 && selectedText.length < 80) {
      input.value = selectedText;
      dispatchSearch(editor, selectedText);
      const searchState = getSearchState(editor);
      updateCountLabel(count, searchState);
      if (searchState && searchState.matches.length > 0) {
        scrollToMatch(editor, searchState.matches[0]);
      }
    }
  }

  input.addEventListener('input', () => {
    const query = input.value;
    dispatchSearch(editor, query);
    const state = getSearchState(editor);
    updateCountLabel(count, state);
    if (state && state.matches.length > 0) {
      scrollToMatch(editor, state.matches[0]);
    }
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateMatch(editor, e.shiftKey ? 'prev' : 'next', count);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchBar(editor);
    }
  });

  prevBtn.addEventListener('click', () => {
    navigateMatch(editor, 'prev', count);
    input.focus();
  });

  nextBtn.addEventListener('click', () => {
    navigateMatch(editor, 'next', count);
    input.focus();
  });

  closeBtn.addEventListener('click', () => {
    closeSearchBar(editor);
  });

  input.focus();
}

// --- TipTap Extension ---

export const SearchBarExtension = Extension.create({
  name: 'searchBar',

  addProseMirrorPlugins() {
    return [createSearchPlugin()];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        openSearchBar(this.editor);
        return true;
      },
    };
  },
});
