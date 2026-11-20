// Google Docs-style autoformat for the rich editor, on top of the markdown
// input rules StarterKit already ships (headings, lists, quotes, code, rules,
// bold, italic, strike, inline code).

import { Extension, InputRule } from '@tiptap/core';
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from '@tiptap/pm/state';
import type { Step } from '@tiptap/pm/transform';

import { parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { isolateSelectedLines } from './lineScopedBlocks';

// `[text](href)` ending at the caret, not an image (`![…]`) or an escaped
// bracket. Node-ref hrefs are left to the chip rule.
const LINK_RE = /(?:^|[^!\\])(\[([^[\]\n]+)\]\(([^()\s]+)\))$/;

function linkInputRule(type: MarkType): InputRule {
  return new InputRule({
    find: LINK_RE,
    handler: ({ state, range, match }) => {
      const [whole, typed, text, href] = match;
      if (!typed || !text || !href || parseNodeRef(href)) return null;
      const start = range.from + whole.length - typed.length;
      const marks = state.doc
        .resolve(start)
        .marks()
        .filter((mark) => mark.type !== type);
      // The closing `)` is still being typed: the rule replaces up to the
      // caret, so it never lands.
      state.tr.replaceWith(
        start,
        range.to,
        state.schema.text(text, [...marks, type.create({ href })])
      );
    },
  });
}

/** The last autoformat, for putting the typed characters back. */
interface AutoformatRecord {
  steps: Step[];
  /** The document before each step. */
  docs: PMNode[];
  /** Where the typed text would have gone, and the text. */
  from: number;
  to: number;
  text: string;
}

/** What TipTap's input-rules plugin stores on the transaction it dispatches. */
interface InputRuleMeta {
  transform: { steps: readonly Step[]; docs: readonly PMNode[] };
  from: number;
  to: number;
  text: string;
}

const autoformatKey = new PluginKey<AutoformatRecord | null>('markdownAutoformatUndo');

// TipTap's own `undoInputRule` forgets the rule as soon as another
// transaction changes the doc, and at the end of the document the
// trailing-node plugin always appends one (a paragraph after the new block),
// so Backspace or Mod-z could not undo an autoformat there. This record
// follows appended transactions and drops out on anything else.
const autoformatUndoPlugin = new Plugin<AutoformatRecord | null>({
  key: autoformatKey,
  state: {
    init: () => null,
    apply(tr, prev, _old, state) {
      // Each extension's input rules run in a plugin of their own.
      let meta: InputRuleMeta | undefined;
      for (const plugin of state.plugins) {
        if (!(plugin.spec as { isInputRules?: boolean }).isInputRules) continue;
        meta = tr.getMeta(plugin) as InputRuleMeta | undefined;
        if (meta) break;
      }
      if (meta) {
        return {
          steps: [...meta.transform.steps],
          docs: [...meta.transform.docs],
          from: meta.from,
          to: meta.to,
          text: meta.text,
        };
      }
      if (prev && tr.getMeta('appendedTransaction')) {
        return { ...prev, steps: [...prev.steps, ...tr.steps], docs: [...prev.docs, ...tr.docs] };
      }
      return tr.docChanged || tr.selectionSet ? null : prev;
    },
  },
});

/** Revert the autoformat that just ran and put back the typed characters. */
const undoAutoformat: Command = (state: EditorState, dispatch) => {
  const record = autoformatKey.getState(state);
  if (!record) return false;
  if (dispatch) {
    const tr = state.tr;
    for (let i = record.steps.length - 1; i >= 0; i--) {
      tr.step(record.steps[i].invert(record.docs[i]));
    }
    // A rule run by Enter (a ``` fence) records a newline: the paragraph
    // never held one, so just leave the typed fence.
    const text = record.text === '\n' ? '' : record.text;
    const marks = tr.doc.resolve(record.from).marks();
    if (text) tr.replaceWith(record.from, record.to, state.schema.text(text, marks));
    else tr.delete(record.from, record.to);
    dispatch(tr);
  }
  return true;
};

// The block prefixes StarterKit's input rules turn into blocks (heading,
// quote, bullet, numbered, task, code fence, divider), complete with the
// character that triggers them.
const BLOCK_PREFIX_RE =
  /^(?:#{1,6}\s|\s*>\s|\s*[-+*]\s|\d+\.\s|\s*\[[ xX]?\]\s|```[a-z]*\s|~~~[a-z]*\s|---|—-|___\s|\*\*\*\s)$/;

// Block input rules only match at the start of a textblock, so a prefix
// typed at the start of a Shift+Enter line did nothing, and one typed at the
// start of a paragraph with more lines formatted all of them. When a prefix
// completes at the start of a line in a paragraph with hard breaks, split
// that line out first, then let the input rules run on it alone.
const lineStartPlugin = new Plugin({
  props: {
    handleTextInput(view, from, to, text) {
      const $from = view.state.doc.resolve(from);
      const block = $from.parent;
      if (!block.isTextblock || block.type.spec.code || to > $from.end()) return false;
      let lineStart = 0;
      let hasBreaks = false;
      block.forEach((child, offset) => {
        if (child.type.name !== 'hardBreak') return;
        hasBreaks = true;
        if (offset < $from.parentOffset) lineStart = offset + 1;
      });
      if (!hasBreaks) return false;
      const line = block.textBetween(lineStart, $from.parentOffset, undefined, '\ufffc');
      if (!BLOCK_PREFIX_RE.test(line + text)) return false;

      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to));
      isolateSelectedLines(tr);
      view.dispatch(tr);
      const start = tr.mapping.map(from);
      const end = tr.mapping.map(to);
      const insert = () => view.state.tr.insertText(text, start, end);
      // The line is a textblock of its own now, so this handler passes and the
      // input rules see a line start.
      const handled = view.someProp('handleTextInput', (f) => f(view, start, end, text, insert));
      if (!handled) view.dispatch(insert());
      return true;
    },
  },
});

export const MarkdownAutoformat = Extension.create({
  name: 'markdownAutoformat',
  // Ahead of the core keymap, history and StarterKit's input rules (100), so
  // Backspace and Mod-z try undoing an autoformat first and a line is split
  // out before a block rule sees it.
  priority: 200,
  addInputRules() {
    const link = this.editor.schema.marks.link;
    return link ? [linkInputRule(link)] : [];
  },
  addProseMirrorPlugins() {
    return [autoformatUndoPlugin, lineStartPlugin];
  },
  addKeyboardShortcuts() {
    const undo = () => undoAutoformat(this.editor.state, this.editor.view.dispatch);
    // Backspace at the very start of a heading turns it into text first,
    // like a list item or quote does, instead of merging it into the block
    // above.
    const headingToText = () => {
      const { selection } = this.editor.state;
      const { $from } = selection;
      if (!selection.empty || $from.parentOffset !== 0) return false;
      if ($from.parent.type.name !== 'heading') return false;
      return this.editor.commands.setParagraph();
    };
    return {
      Backspace: () => undo() || headingToText(),
      'Mod-z': undo,
    };
  },
});
