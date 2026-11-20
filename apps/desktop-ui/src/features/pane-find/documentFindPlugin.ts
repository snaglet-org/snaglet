import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import { findText, type TextMatch } from './findText';

/** Search contiguous editable text, including across marks, excluding chips and block seams. */
export function findDocumentText(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive: boolean
): TextMatch[] {
  const runs: { text: string; from: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const last = runs[runs.length - 1];
    if (last && last.from + last.text.length === pos) last.text += node.text;
    else runs.push({ text: node.text, from: pos });
  });
  return runs.flatMap((run) =>
    findText(run.text, query, caseSensitive).map((match) => ({
      from: run.from + match.from,
      to: run.from + match.to,
    }))
  );
}

interface FindState {
  query: string;
  caseSensitive: boolean;
  index: number;
}
export const documentFindKey = new PluginKey<FindState>('snaglet-pane-find');

export function createDocumentFindPlugin() {
  return new Plugin<FindState>({
    key: documentFindKey,
    state: {
      init: () => ({ query: '', caseSensitive: false, index: 0 }),
      apply: (transaction, state) =>
        (transaction.getMeta(documentFindKey) as FindState | undefined) ?? state,
    },
    props: {
      decorations(state) {
        const find = documentFindKey.getState(state);
        if (!find?.query) return DecorationSet.empty;
        const matches = findDocumentText(state.doc, find.query, find.caseSensitive);
        return DecorationSet.create(
          state.doc,
          matches.map((match, index) =>
            Decoration.inline(match.from, match.to, {
              class:
                index === Math.min(find.index, matches.length - 1)
                  ? 'snaglet-find-match snaglet-find-current'
                  : 'snaglet-find-match',
            })
          )
        );
      },
    },
  });
}

export function replaceDocumentMatches(
  editor: Editor,
  matches: readonly TextMatch[],
  replacement: string
): void {
  if (!editor.isEditable || !matches.length) return;
  const transaction = closeHistory(editor.state.tr);
  for (const match of [...matches].reverse())
    transaction.insertText(replacement, match.from, match.to);
  editor.view.dispatch(transaction);
  // The following keystroke must not merge into the replace-all undo event.
  editor.view.dispatch(closeHistory(editor.state.tr));
}
