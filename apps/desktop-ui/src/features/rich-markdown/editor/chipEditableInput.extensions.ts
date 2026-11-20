import type { RefObject } from 'react';
import { Extension, type Extensions } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

import { ChipNode } from './ChipNode';
import { DeletableTable } from './deletableTable';
import { LineScopedBlocks } from './lineScopedBlocks';
import { LinkOpen } from './linkOpen';
import { MarkdownAutoformat } from './markdownAutoformat';
import { MermaidCodeBlock } from './MermaidCodeBlock';
import type { MentionState, SlashState } from './chipEditableInput.helpers';

export interface SubmitExtensionDeps {
  onSubmitRef: RefObject<(() => void) | undefined>;
  multilineRef: RefObject<boolean>;
  submitOnEnterRef: RefObject<boolean>;
  richBlocksRef: RefObject<boolean>;
  mentionStateRef: RefObject<MentionState | null>;
  slashStateRef: RefObject<SlashState | null>;
}

// Enter keymap. Priority 1000 runs it before StarterKit's Paragraph keymap,
// which would otherwise split the paragraph on bare Enter.
//
//   single-line                  → Enter submits, Shift+Enter ignored
//   multiline + submitOnEnter    → Enter submits, Shift+Enter newline (chat)
//   multiline (default)          → Enter newline, Shift+Enter newline (doc)
//   any mode                     → Cmd/Ctrl+Enter always submits
//
// With `submitOnEnter` in rich mode, Enter inside a list, code block or
// table keeps editing so multi-item blocks can be typed.
export function createSubmitExtension(deps: SubmitExtensionDeps): Extension {
  const {
    onSubmitRef,
    multilineRef,
    submitOnEnterRef,
    richBlocksRef,
    mentionStateRef,
    slashStateRef,
  } = deps;
  return Extension.create({
    name: 'chipEditableSubmit',
    priority: 1000,
    addKeyboardShortcuts() {
      const submit = () => {
        onSubmitRef.current?.();
        return true;
      };
      const inStructuredBlock = (ed: Editor) =>
        ed.isActive('listItem') ||
        ed.isActive('taskItem') ||
        ed.isActive('codeBlock') ||
        ed.isActive('table');
      return {
        'Mod-Enter': submit,
        Enter: () => {
          // An Enter the open search did not take (no hits) must not split a
          // one-line field into two paragraphs.
          if (!multilineRef.current) return submit();
          if (mentionStateRef.current || slashStateRef.current) return false;
          if (!submitOnEnterRef.current) return false;
          if (richBlocksRef.current && inStructuredBlock(this.editor)) return false;
          return submit();
        },
      };
    },
  });
}

export interface ChipEditableExtensionsConfig {
  submitExtension: Extension;
  richBlocks: boolean;
  dropcursorConfig: { width: number; color: false; class: string };
  multiline: boolean;
  allowInlineParse: boolean;
  placeholder?: string;
}

export function buildChipEditableExtensions(config: ChipEditableExtensionsConfig): Extensions {
  const {
    submitExtension,
    richBlocks,
    dropcursorConfig,
    multiline,
    allowInlineParse,
    placeholder,
  } = config;
  return [
    submitExtension,
    richBlocks
      ? // Rich block mode: all blocks plus StarterKit's markdown input rules.
        StarterKit.configure({
          dropcursor: dropcursorConfig,
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          // `MermaidCodeBlock` below provides the code block node.
          codeBlock: false,
          // Underline has no markdown form, so the serializer can't keep it.
          underline: false,
          // No autolink, so pasted bare URLs don't rewrite the markdown.
          // A plain click places the caret; `LinkOpen` opens on ⌘/Ctrl-click.
          link: { autolink: false, openOnClick: false },
        })
      : StarterKit.configure({
          // Plain text field: paragraphs, drop/gap cursors, undo and
          // trailing node only.
          blockquote: false,
          bulletList: false,
          codeBlock: false,
          heading: false,
          horizontalRule: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          dropcursor: dropcursorConfig,
          // Inline marks: off — the host stores plain text/chips only.
          bold: false,
          italic: false,
          strike: false,
          underline: false,
          code: false,
          // Links off: node refs are chips, and autolink would wrap ids.
          link: false,
          // Single-line: no hard breaks. Multiline: keep StarterKit's
          // default <br>-on-Shift-Enter behavior.
          hardBreak: multiline ? undefined : false,
        }),
    ...(richBlocks
      ? [
          MermaidCodeBlock,
          // Block commands change only the selected lines of a paragraph
          // that holds hard breaks.
          LineScopedBlocks,
          // Google Docs-style autoformat beyond StarterKit's input rules.
          MarkdownAutoformat,
          LinkOpen,
          TaskList,
          // `[ ] ` / `[x] ` input rules and checkbox node views.
          TaskItem.configure({ nested: true }),
          // GFM pipe tables (no resizing: markdown can't store column
          // widths), each with a × at its corner that deletes it.
          DeletableTable,
          TableRow,
          TableHeader,
          TableCell,
        ]
      : []),
    ChipNode.configure({
      showIncludeToggle: allowInlineParse,
      // Typed or pasted bare ids always become chips; `passIdOnly` only
      // decides how they serialize.
      parseBareIds: true,
    }),
    Placeholder.configure({ placeholder: placeholder ?? '' }),
  ];
}
