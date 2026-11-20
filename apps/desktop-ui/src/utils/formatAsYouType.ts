import { isHistoryTransaction } from '@tiptap/pm/history';
import { Fragment, Slice, type Mark } from '@tiptap/pm/model';
import { Plugin, TextSelection, type PluginKey } from '@tiptap/pm/state';

/**
 * Rewrites text as the user edits it, e.g. `formatTableName`. It must keep
 * earlier text stable — formatting a prefix gives a prefix of the formatted
 * whole — so a caret offset maps to `format(textBeforeCaret).length`.
 */
export type TextFormat = (text: string) => string;

/**
 * Applies `format` to a native text field from its `onChange` and returns the
 * text to store. A controlled field handed a changed value parks the caret at
 * the end; rewriting `value` here and restoring the selection keeps it beside
 * what the user typed, and React then finds the DOM already matching its state.
 */
export function formatFieldValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  format: TextFormat
): string {
  const text = field.value;
  const next = format(text);
  if (next === text) return text;
  const { selectionStart, selectionEnd, selectionDirection } = field;
  field.value = next;
  if (selectionStart !== null && selectionEnd !== null) {
    field.setSelectionRange(
      format(text.slice(0, selectionStart)).length,
      format(text.slice(0, selectionEnd)).length,
      selectionDirection ?? undefined
    );
  }
  return next;
}

interface TextEdit {
  from: number;
  text: string;
  next: string;
  marks: readonly Mark[];
}

/**
 * The ProseMirror twin of {@link formatFieldValue}, for single-line inputs:
 * after each user edit, `format` runs over every text node in the same undo
 * step and the caret stays beside what the user typed. A loaded value
 * (`preventUpdate`) is left as loaded, undo and redo restore exactly what they
 * recorded, and IME composition is left alone until a later edit, since
 * rewriting text mid-composition breaks the IME.
 *
 * A paste is formatted as one line before ProseMirror would split it into
 * paragraphs, so its line breaks reach `format` like any other whitespace.
 */
export function createFormatTextPlugin(key: PluginKey, format: TextFormat): Plugin {
  return new Plugin({
    key,
    props: {
      transformPastedText: (text) => format(text),
      transformPasted: (slice, view) => {
        if (slice.content.childCount < 2) return slice;
        const text = format(slice.content.textBetween(0, slice.content.size, '\n'));
        return text ? new Slice(Fragment.from(view.state.schema.text(text)), 0, 0) : Slice.empty;
      },
    },
    appendTransaction(transactions, _previous, state) {
      const edited = transactions.some(
        (tr) => tr.docChanged && !tr.getMeta('preventUpdate') && !isHistoryTransaction(tr)
      );
      if (!edited || transactions.some((tr) => tr.getMeta('composition') !== undefined))
        return null;
      const edits: TextEdit[] = [];
      state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const next = format(node.text);
        if (next !== node.text) edits.push({ from: pos, text: node.text, next, marks: node.marks });
      });
      if (edits.length === 0) return null;

      const tr = state.tr;
      // Last first, so every earlier edit's position still holds.
      for (const { from, text, next, marks } of [...edits].reverse()) {
        const to = from + text.length;
        if (next) tr.replaceWith(from, to, state.schema.text(next, marks));
        else tr.delete(from, to);
      }
      const mapPos = (pos: number): number => {
        let shift = 0;
        for (const { from, text, next } of edits) {
          if (pos <= from) break;
          const offset = pos - from;
          if (offset < text.length) return from + shift + format(text.slice(0, offset)).length;
          shift += next.length - text.length;
        }
        return pos + shift;
      };
      const { selection } = state;
      if (selection instanceof TextSelection) {
        tr.setSelection(
          TextSelection.create(tr.doc, mapPos(selection.anchor), mapPos(selection.head))
        );
      }
      return tr;
    },
  });
}
