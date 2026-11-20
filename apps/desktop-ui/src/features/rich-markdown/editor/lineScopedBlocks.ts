// Block commands act on whole textblocks, but Shift+Enter (and pasted `<br>`s
// or markdown hard breaks) put several visual lines in one paragraph. Turning
// one of those lines into a heading or list would convert every line of the
// paragraph, and a heading holding a hard break does not survive the markdown
// round trip. This extension splits the selected lines out of their paragraph
// at the surrounding hard breaks first, so a block command changes exactly
// the lines the selection is on, and the whole change stays one undo step.

import { Extension, commands as coreCommands, getNodeType, type CommandProps } from '@tiptap/core';
import { canSplit } from '@tiptap/pm/transform';
import type { Transaction } from '@tiptap/pm/state';

interface IsolateOptions {
  /** Keep the hard breaks between selected lines (a code block or quote
   *  keeps those lines together); otherwise every selected line becomes its
   *  own block. */
  keepInnerBreaks?: boolean;
}

/**
 * Split the lines under `tr.selection` out of their textblocks at the hard
 * breaks around them. Breaks inside the selection are split too unless
 * `keepInnerBreaks`. The selection stays on the same text. Code blocks are
 * left alone: their line breaks are text.
 */
export function isolateSelectedLines(tr: Transaction, options: IsolateOptions = {}): void {
  const { from, to } = tr.selection;
  const cuts: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let before: number | null = null;
    let after: number | null = null;
    node.forEach((child, offset) => {
      if (child.type.name !== 'hardBreak') return;
      const at = pos + 1 + offset;
      if (at < from) before = at;
      else if (at >= to) after ??= at;
      else if (!options.keepInnerBreaks) cuts.push(at);
    });
    if (before !== null) cuts.push(before);
    if (after !== null) cuts.push(after);
    return false;
  });
  // Back to front, so earlier positions stay valid. Splitting after the break
  // and then dropping it keeps a caret on either side of it on its own line.
  for (const at of cuts.sort((a, b) => b - a)) {
    if (!canSplit(tr.doc, at + 1)) continue;
    tr.split(at + 1).delete(at, at + 1);
  }
}

/** `isolateSelectedLines` on a command's transaction. The command's
 *  chainable `state` caches doc and selection until `state.tr` is read, so
 *  read it to hand the wrapped command the split document. */
function isolate(props: CommandProps, options?: IsolateOptions): void {
  isolateSelectedLines(props.tr, options);
  void props.state.tr;
}

/** The textblock a line-scoped block conversion would leave as is. */
function isParagraphTarget(typeOrName: Parameters<typeof getNodeType>[0], tr: Transaction) {
  return getNodeType(typeOrName, tr.doc.type.schema).name === 'paragraph';
}

/**
 * Wraps TipTap's block commands (`setNode`, `wrapIn`, `wrapInList`) so every
 * caller (slash menu, keyboard shortcuts, the format menu) is line-scoped:
 * `setHeading`, `toggleHeading`, `setCodeBlock`, `toggleBlockquote`,
 * `toggleBulletList`, … all route through these.
 */
export const LineScopedBlocks = Extension.create({
  name: 'lineScopedBlocks',
  // Commands merge in priority order, so a lower priority than the core
  // extensions (100) makes these override the core versions.
  priority: 50,
  addCommands() {
    return {
      setNode: (typeOrName, attributes) => (props) => {
        // Turning lines back into text keeps them in their paragraph.
        if (
          props.dispatch &&
          !isParagraphTarget(typeOrName, props.tr) &&
          props.can().setNode(typeOrName, attributes)
        ) {
          const type = getNodeType(typeOrName, props.tr.doc.type.schema);
          isolate(props, { keepInnerBreaks: Boolean(type.spec.code) });
        }
        return coreCommands.setNode(typeOrName, attributes)(props);
      },
      wrapIn: (typeOrName, attributes) => (props) => {
        if (props.dispatch && props.can().wrapIn(typeOrName, attributes)) {
          isolate(props, { keepInnerBreaks: true });
        }
        return coreCommands.wrapIn(typeOrName, attributes)(props);
      },
      wrapInList: (typeOrName, attributes) => (props) => {
        if (props.dispatch && props.can().wrapInList(typeOrName, attributes)) {
          isolate(props);
        }
        return coreCommands.wrapInList(typeOrName, attributes)(props);
      },
    };
  },
});
