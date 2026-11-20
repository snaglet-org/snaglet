// Slash-command block menu for the rich editor. Like NodeMentionSearch, the
// host detects `/query` at the caret, renders this menu and routes keydowns
// through `handleKeyDown` so arrows, Enter and Escape drive the menu.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import { rerenderLiteralMarkdown } from './richMarkdown';
import {
  EditorPopover,
  EditorPopoverHeader,
  editorPopoverStyles as popoverStyles,
  type EditorPopoverAnchor,
} from './EditorPopover';

export type SlashMenuAnchor = NonNullable<EditorPopoverAnchor>;

export interface SlashMenuHandle {
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  /** Mono glyph rendered in the row's left slot. */
  glyph: string;
  keywords: string[];
  /** Context gate — e.g. table row/column ops only show inside a table.
   *  Omitted = always available. */
  when?: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const inTable = (ed: Editor) => ed.isActive('table');

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    glyph: '¶',
    keywords: ['text', 'paragraph', 'plain', 'p'],
    run: (ed) => ed.chain().focus().setParagraph().run(),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    hint: '# Large section heading',
    glyph: 'H1',
    keywords: ['heading', 'h1', 'title', '#'],
    run: (ed) => ed.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: '## Medium section heading',
    glyph: 'H2',
    keywords: ['heading', 'h2', 'subtitle', '##'],
    run: (ed) => ed.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: '### Small section heading',
    glyph: 'H3',
    keywords: ['heading', 'h3', '###'],
    run: (ed) => ed.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    hint: '- Unordered list',
    glyph: '•',
    keywords: ['bullet', 'list', 'unordered', 'ul', '-'],
    run: (ed) => ed.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    hint: '1. Ordered list',
    glyph: '1.',
    keywords: ['numbered', 'ordered', 'list', 'ol', '1'],
    run: (ed) => ed.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: 'Task list',
    hint: '[ ] Checkboxes',
    glyph: '☐',
    keywords: ['task', 'todo', 'checkbox', 'check', '[]'],
    run: (ed) => ed.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: '> Block quote',
    glyph: '❝',
    keywords: ['quote', 'blockquote', '>'],
    run: (ed) => ed.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: '``` Fenced code',
    glyph: '{}',
    keywords: ['code', 'codeblock', 'fence', 'snippet', '```'],
    run: (ed) => ed.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: '--- Horizontal rule',
    glyph: '—',
    keywords: ['divider', 'rule', 'separator', 'hr', '---'],
    run: (ed) => ed.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'rerender-markdown',
    label: 'Re-render markdown',
    hint: 'Convert literal markdown text into blocks',
    glyph: 'M↓',
    keywords: ['markdown', 'rerender', 'render', 'parse', 'convert', 'format', 'fix'],
    run: rerenderLiteralMarkdown,
  },
  {
    id: 'table',
    label: 'Table',
    hint: '3×3 with header row',
    glyph: '⊞',
    keywords: ['table', 'grid', 'columns', 'rows'],
    // Markdown can't nest tables, so don't offer one inside a cell.
    when: (ed) => !inTable(ed),
    run: (ed) => ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'row-above',
    label: 'Row above',
    hint: 'Insert a row above',
    glyph: '↑+',
    keywords: ['row', 'above', 'insert'],
    when: inTable,
    run: (ed) => ed.chain().focus().addRowBefore().run(),
  },
  {
    id: 'row-below',
    label: 'Row below',
    hint: 'Insert a row below',
    glyph: '↓+',
    keywords: ['row', 'below', 'insert'],
    when: inTable,
    run: (ed) => ed.chain().focus().addRowAfter().run(),
  },
  {
    id: 'col-left',
    label: 'Column left',
    hint: 'Insert a column to the left',
    glyph: '←+',
    keywords: ['column', 'left', 'insert', 'col'],
    when: inTable,
    run: (ed) => ed.chain().focus().addColumnBefore().run(),
  },
  {
    id: 'col-right',
    label: 'Column right',
    hint: 'Insert a column to the right',
    glyph: '→+',
    keywords: ['column', 'right', 'insert', 'col'],
    when: inTable,
    run: (ed) => ed.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'delete-row',
    label: 'Delete row',
    hint: 'Remove the current row',
    glyph: '–r',
    keywords: ['delete', 'remove', 'row'],
    when: inTable,
    run: (ed) => ed.chain().focus().deleteRow().run(),
  },
  {
    id: 'delete-col',
    label: 'Delete column',
    hint: 'Remove the current column',
    glyph: '–c',
    keywords: ['delete', 'remove', 'column', 'col'],
    when: inTable,
    run: (ed) => ed.chain().focus().deleteColumn().run(),
  },
  {
    id: 'delete-table',
    label: 'Delete table',
    hint: 'Remove the whole table',
    glyph: '–t',
    keywords: ['delete', 'remove', 'table'],
    when: inTable,
    run: (ed) => ed.chain().focus().deleteTable().run(),
  },
];

function filterSlashCommands(query: string, editor: Editor | null): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const available = SLASH_COMMANDS.filter((c) => !c.when || (editor ? c.when(editor) : !c.when));
  if (!q) return available;
  return available.filter(
    (c) => c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.startsWith(q))
  );
}

export interface SlashMenuProps {
  query: string;
  anchor: SlashMenuAnchor;
  /** Live editor, for context-dependent commands (table ops). */
  editor: Editor | null;
  onPick: (command: SlashCommand) => void;
  /** Called when no command matches the query. */
  onClose: () => void;
  /** Escape: the user turned the menu down for this `/` token. */
  onDismiss: () => void;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { query, anchor, editor, onPick, onClose, onDismiss },
  ref
) {
  const commands = useMemo(() => filterSlashCommands(query, editor), [query, editor]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Hover moves the highlight only once the pointer really moves: commands
  // that appear under a resting pointer must not take Enter/Tab from the first.
  const pointer = usePointerMoveGate();

  // Every query change puts the highlight back on the first command. The menu
  // mounts fresh each time it opens, which starts it there too.
  useEffect(() => {
    setActive(0);
    pointer.reset();
  }, [query, pointer]);

  // Clamp the highlight as the filter narrows.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  // No matches → the user typed something that isn't a command; close so
  // they can just keep writing prose that happens to start with `/`.
  useEffect(() => {
    if (commands.length === 0) onClose();
  }, [commands.length, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((a) => (a + 1) % Math.max(1, commands.length));
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((a) => (a - 1 + Math.max(1, commands.length)) % Math.max(1, commands.length));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (commands.length === 0) return false;
          event.preventDefault();
          onPick(commands[active] ?? commands[0]);
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss();
          return true;
        }
        return false;
      },
    }),
    [active, commands, onDismiss, onPick]
  );

  const trimmedQuery = query.trim();

  return (
    <EditorPopover anchor={anchor} ariaLabel="Block commands">
      <EditorPopoverHeader
        glyph="/"
        text={trimmedQuery ? `Command: ${trimmedQuery}` : 'Commands'}
        muted={!trimmedQuery}
      />
      <ul ref={listRef} className={popoverStyles.list}>
        {commands.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              className={`${popoverStyles.row} ${popoverStyles.rowKeyed} ${
                i === active ? popoverStyles.rowActive : ''
              }`.trim()}
              role="option"
              aria-selected={i === active}
              // Mousedown (not click) so the editor never loses focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseMove={(e) => {
                if (pointer.moved(e)) setActive(i);
              }}
            >
              <span className={popoverStyles.body}>
                <span className={popoverStyles.label}>{c.label}</span>
                <span className={popoverStyles.meta}>{c.hint}</span>
              </span>
              <span className={popoverStyles.kind} aria-hidden>
                {c.glyph}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </EditorPopover>
  );
});
