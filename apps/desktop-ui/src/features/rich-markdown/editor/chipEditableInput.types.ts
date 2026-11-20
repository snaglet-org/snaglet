import type { Editor } from '@tiptap/core';
import type { ReactNode } from 'react';
import type { PaletteNodeKind } from '@snaglet/shared';

export interface ChipEditableInputProps {
  /** Exposes the editor for pane-local find decorations; cleared on unmount. */
  onEditorReady?: (editor: Editor | null) => void;
  /** Keep the caret on the same text when `value` changes from outside while
   *  focused. Off for hosts that append to `value` and want the caret to
   *  follow (the chat composer). */
  keepSelectionOnExternalChange?: boolean;
  /** Canonical markdown. Chips appear as `[Title](href)` or `![](href)`. */
  value: string;
  /** Called with the serialized markdown after every user edit. */
  onChange: (next: string) => void;

  placeholder?: string;
  /** Enter inserts a newline. When false (default), Enter calls `onSubmit`. */
  multiline?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;

  /** Forwarded to the contenteditable element so host input styling applies. */
  className?: string;
  /** `aria-label` for the editor. */
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;

  /** Fires on Enter (single-line) or Cmd/Ctrl+Enter (multiline), and on
   *  bare Enter when `submitOnEnter` is set. */
  onSubmit?: () => void;

  /** Multiline only: Enter submits and Shift+Enter inserts a newline.
   *  Cmd/Ctrl+Enter always submits. Default false. */
  submitOnEnter?: boolean;

  /** Show the `.md-chip-toggle` on doc chips to flip between `[Title](doc)`
   *  and the transclusion form `![](doc)`. */
  allowInlineParse?: boolean;

  /** Add an edit/preview tab; preview renders the full markdown via
   *  `MarkdownRenderer`. */
  allowMarkdownPreview?: boolean;

  /** Initial tab when `allowMarkdownPreview` is set. Default `'edit'`;
   *  read-first surfaces such as the doc body pass `'preview'`. */
  defaultMode?: 'edit' | 'preview';

  /** Called with the updated markdown when a GFM checkbox is toggled in
   *  preview. When set, the toggle skips `onChange` and saves at once. */
  onCheckboxAutoSave?: (updatedMarkdown: string) => void;

  /** Serialize chips as bare node ids (`doc-abc-123`) instead of
   *  `[Title](doc-abc-123)`, for hosts that consume the id directly (tool
   *  params, the doc title). Chips still display as chips. */
  passIdOnly?: boolean;

  /** Enable `@` workspace-node mention search. Default on. */
  enableNodeMentions?: boolean;
  /** Optional thread context for scoped mention searches such as `file:`. */
  threadId?: string;
  /** Offer only these kinds in the mention search (a one-kind picker field). */
  mentionKinds?: readonly PaletteNodeKind[];
  /** Search on any typed text, not only after `@` (picker fields). */
  mentionOnType?: boolean;

  /** Rich block mode: WYSIWYG markdown blocks with input rules and a `/`
   *  slash menu. The surface is its own preview, so `allowMarkdownPreview`,
   *  `defaultMode` and double-click-to-edit are ignored. The value is still
   *  plain markdown, round-tripped via `richMarkdown.ts`. */
  richBlocks?: boolean;

  /** Content in the mode-toggle row, left of the edit/preview pill (e.g. a
   *  status pill). Renders only when `allowMarkdownPreview` is on. */
  topRightSlot?: ReactNode;
}

export type Mode = 'edit' | 'preview';
