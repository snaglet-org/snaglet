/**
 * Test harness for the rich (block) markdown editor: mounts the real
 * ChipEditableInput in `richBlocks` mode behind a controlled host and drives
 * it the way a user does (typed text goes through input rules, keys through
 * the keymaps). Import it after mocking `@desktop/utils/api` (see the tests).
 */
import { useState, type FC, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

import { ChipEditableInput } from './ChipEditableInput';

export interface RichEditorHarness {
  box: HTMLElement;
  editor: () => Editor;
  /** The markdown the host last received from `onChange`. */
  value: () => string;
  /** Types text one character at a time, through the input rules. */
  type: (text: string) => void;
  /** Fires a keydown on the editor (`Mod` is Ctrl under jsdom). */
  press: (key: string, mods?: KeyMods) => void;
  /** Block outline of the document (see `outline`). */
  outline: () => string[];
  /** Puts the caret at offset `offset` into the first occurrence of `text`,
   *  or selects from `text` to the end of `toText` when given. */
  caretAt: (text: string, offset?: number) => void;
  select: (fromText: string, toText: string) => void;
  /** Pastes `text` as a plain-text clipboard (no HTML), like a paste from a
   *  text editor: through the editor's clipboard text parser. */
  paste: (text: string) => void;
}

interface KeyMods {
  shift?: boolean;
  alt?: boolean;
  mod?: boolean;
}

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
};

/**
 * A compact, readable outline: `p:text`, `h3:text`, `code:text`, containers as
 * `bulletList(listItem(p:a), …)`. Hard breaks show as `⏎`.
 */
function outline(doc: PMNode): string[] {
  const render = (node: PMNode): string => {
    if (node.isTextblock) {
      let text = '';
      node.forEach((child) => {
        text += child.isText ? child.text : child.type.name === 'hardBreak' ? '⏎' : '◆';
      });
      const name =
        node.type.name === 'paragraph'
          ? 'p'
          : node.type.name === 'heading'
            ? `h${String(node.attrs.level)}`
            : node.type.name === 'codeBlock'
              ? 'code'
              : node.type.name;
      return `${name}:${text}`;
    }
    if (node.isLeaf) return node.type.name;
    const children: string[] = [];
    node.forEach((child) => children.push(render(child)));
    const attrs = node.type.name === 'taskItem' ? `[${node.attrs.checked ? 'x' : ' '}]` : '';
    return `${node.type.name}${attrs}(${children.join(', ')})`;
  };
  const out: string[] = [];
  doc.forEach((node) => out.push(render(node)));
  // The trailing-node extension keeps an empty paragraph at the end.
  while (out.length > 1 && out[out.length - 1] === 'p:') out.pop();
  return out;
}

function findText(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text) {
      const i = node.text.indexOf(text);
      if (i >= 0) found = pos + i;
    }
    return true;
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

export async function mountRichEditor(
  initial = '',
  options: { disabled?: boolean; wrapper?: FC<{ children: ReactNode }> } = {}
): Promise<RichEditorHarness> {
  let editor: Editor | null = null;
  let last = initial;
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <ChipEditableInput
        value={value}
        onChange={(next) => {
          last = next;
          setValue(next);
        }}
        onEditorReady={(next) => {
          editor = next;
        }}
        richBlocks
        multiline
        ariaLabel="Note"
        enableNodeMentions={false}
        disabled={options.disabled}
      />
    );
  }
  render(<Host />, { wrapper: options.wrapper });
  const box = await screen.findByRole('textbox', { name: 'Note' });
  await waitFor(() => expect(editor).not.toBeNull());
  // Let the value hydrate (a microtask after the layout effect).
  await act(async () => Promise.resolve());
  const ed = () => editor!;
  act(() => ed().view.focus());

  const type = (text: string) => {
    for (const ch of text) {
      act(() => {
        const { view } = ed();
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(ch, from, to);
        const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert));
        if (!handled) view.dispatch(insert());
      });
    }
  };

  const press = (key: string, mods: KeyMods = {}) => {
    const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    act(() => {
      fireEvent.keyDown(box, {
        key,
        keyCode,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
        ctrlKey: mods.mod ?? false,
      });
    });
  };

  const caretAt = (text: string, offset = 0) => {
    act(() => {
      const pos = findText(ed().state.doc, text) + offset;
      ed().view.dispatch(ed().state.tr.setSelection(TextSelection.create(ed().state.doc, pos)));
    });
  };

  const select = (fromText: string, toText: string) => {
    act(() => {
      const { doc } = ed().state;
      const from = findText(doc, fromText);
      const to = findText(doc, toText) + toText.length;
      ed().view.dispatch(ed().state.tr.setSelection(TextSelection.create(doc, from, to)));
    });
  };

  const paste = (text: string) => {
    act(() => {
      const { view } = ed();
      const slice = view.someProp('clipboardTextParser', (f) =>
        f(text, view.state.selection.$from, false, view)
      );
      if (slice) view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
    });
  };

  return {
    box,
    editor: ed,
    paste,
    value: () => last,
    type,
    press,
    outline: () => outline(ed().state.doc),
    caretAt,
    select,
  };
}

/** jsdom lacks the layout APIs ProseMirror and the popovers call. */
export function installEditorDomShims(): void {
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
}
