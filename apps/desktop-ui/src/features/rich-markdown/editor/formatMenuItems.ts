// The formats the rich editor's right-click menu offers: "turn into" block
// types for the blocks under the selection, and inline marks for the
// selected text. Each runs as one transaction (one undo step) and keeps the
// selection; block items are line-scoped (see `lineScopedBlocks.ts`).

import type { Editor } from '@tiptap/react';

export interface FormatMenuItem {
  id: string;
  label: string;
  /** Modifier-key parts of the existing keyboard shortcut, `Mod` first. */
  keys?: string[];
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const inList = (ed: Editor) =>
  ed.isActive('bulletList') || ed.isActive('orderedList') || ed.isActive('taskList');

/** Turn into: toggles, so picking the checked format turns the block back
 *  into text. */
export const BLOCK_FORMATS: FormatMenuItem[] = [
  {
    id: 'paragraph',
    label: 'Text',
    keys: ['Mod', 'Alt', '0'],
    isActive: (ed) => ed.isActive('paragraph') && !inList(ed) && !ed.isActive('blockquote'),
    // Lifts out of lists and quotes too, not just the textblock type.
    run: (ed) => ed.chain().focus().clearNodes().setParagraph().run(),
  },
  ...([1, 2, 3] as const).map(
    (level): FormatMenuItem => ({
      id: `h${level}`,
      label: `Heading ${level}`,
      keys: ['Mod', 'Alt', String(level)],
      isActive: (ed) => ed.isActive('heading', { level }),
      run: (ed) => ed.chain().focus().toggleHeading({ level }).run(),
    })
  ),
  {
    id: 'bullet',
    label: 'Bullet list',
    keys: ['Mod', 'Shift', '8'],
    isActive: (ed) => ed.isActive('bulletList'),
    run: (ed) => ed.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    keys: ['Mod', 'Shift', '7'],
    isActive: (ed) => ed.isActive('orderedList'),
    run: (ed) => ed.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: 'Task list',
    keys: ['Mod', 'Shift', '9'],
    isActive: (ed) => ed.isActive('taskList'),
    run: (ed) => ed.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Quote',
    keys: ['Mod', 'Shift', 'B'],
    isActive: (ed) => ed.isActive('blockquote'),
    run: (ed) => ed.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: 'Code block',
    keys: ['Mod', 'Alt', 'C'],
    isActive: (ed) => ed.isActive('codeBlock'),
    run: (ed) => ed.chain().focus().toggleCodeBlock().run(),
  },
];

/** Inline marks on the selected text. Link is handled by the menu, which
 *  asks for the address. */
export const INLINE_FORMATS: FormatMenuItem[] = [
  {
    id: 'bold',
    label: 'Bold',
    keys: ['Mod', 'B'],
    isActive: (ed) => ed.isActive('bold'),
    run: (ed) => ed.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    label: 'Italic',
    keys: ['Mod', 'I'],
    isActive: (ed) => ed.isActive('italic'),
    run: (ed) => ed.chain().focus().toggleItalic().run(),
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    keys: ['Mod', 'Shift', 'S'],
    isActive: (ed) => ed.isActive('strike'),
    run: (ed) => ed.chain().focus().toggleStrike().run(),
  },
  {
    id: 'code-inline',
    label: 'Inline code',
    keys: ['Mod', 'E'],
    isActive: (ed) => ed.isActive('code'),
    run: (ed) => ed.chain().focus().toggleCode().run(),
  },
];
