import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Node as PMNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorProps } from '@tiptap/pm/view';

import markdownStyles from '@desktop/features/rich-markdown/renderer/MarkdownRenderer.module.scss';
import { parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';
import {
  acceptDroppedChips,
  chipHrefForNode,
  hasChipDragData,
  nodeTitle,
  readChipDragList,
  type NodeChipData,
} from '@desktop/utils/nodeChip';

import { isMermaidPreviewDrop } from '../renderer/mermaidDrag';
import { isMermaidBlock } from '../renderer/isMermaidBlock';
import { pastedTextToSlice } from './richMarkdown';
import type { NodeMentionSearchHandle } from './NodeMentionSearch';
import type { SlashMenuHandle } from './SlashMenu';
import type { MentionState, SlashState } from './chipEditableInput.helpers';
import styles from './ChipEditableInput.module.scss';

export interface ChipEditorPropsConfig {
  richBlocks: boolean;
  className?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  multiline: boolean;
  slashStateRef: RefObject<SlashState | null>;
  mentionStateRef: RefObject<MentionState | null>;
  slashMenuRef: RefObject<SlashMenuHandle | null>;
  mentionSearchRef: RefObject<NodeMentionSearchHandle | null>;
  setMentionState: Dispatch<SetStateAction<MentionState | null>>;
  setSlashState: Dispatch<SetStateAction<SlashState | null>>;
}

/** The editor chip node for a dropped workspace item. */
function droppedChipNode(schema: Schema, dragged: NodeChipData): PMNode {
  const href = chipHrefForNode(dragged);
  const ref = parseNodeRef(href);
  return schema.nodes.chip.create({
    href,
    title: dragged.kind === 'entry' ? (dragged.title ?? dragged.name ?? '') : nodeTitle(dragged),
    include: false,
    kind: ref?.kind ?? dragged.kind,
  });
}

/** Chips separated by a space, the way typed `@` mentions leave them. */
function droppedChipNodes(schema: Schema, chips: readonly NodeChipData[]): PMNode[] {
  return chips.flatMap((chip, i) => {
    const node = droppedChipNode(schema, chip);
    return i === 0 ? [node] : [schema.text(' '), node];
  });
}

export function createChipEditorProps(config: ChipEditorPropsConfig): EditorProps {
  const {
    richBlocks,
    className,
    ariaLabel,
    ariaInvalid,
    ariaDescribedBy,
    multiline,
    slashStateRef,
    mentionStateRef,
    slashMenuRef,
    mentionSearchRef,
    setMentionState,
    setSlashState,
  } = config;

  return {
    // Rich mode: parse pasted plain text as markdown so `# headings`,
    // `- lists`, tables, … convert to real blocks on paste. HTML
    // pastes keep ProseMirror's normal HTML parsing except whole raw
    // flowcharts, whose text is preserved by handlePaste below.
    ...(richBlocks
      ? {
          // Code editors often put both HTML and text on the clipboard. Use
          // the original text for a whole diagram, before HTML loses its layout.
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData('text/plain');
            if (
              !text ||
              view.state.selection.$from.parent.type.spec.code ||
              !isMermaidBlock(null, text)
            )
              return false;
            view.dispatch(
              closeHistory(view.state.tr)
                .setMeta('paste', true)
                .setMeta('uiEvent', 'paste')
                .replaceSelection(pastedTextToSlice(text, view.state.schema, false))
                .scrollIntoView()
            );
            return true;
          },
          clipboardTextParser: (text: string, $context: ResolvedPos, plain: boolean) =>
            pastedTextToSlice(text, $context.doc.type.schema, plain),
        }
      : {}),
    attributes: {
      // Rich mode uses MarkdownRenderer's typography class so blocks look
      // like rendered markdown.
      class: `${styles.editable} ${
        richBlocks ? `${markdownStyles.markdown} ${styles.richEditable}` : ''
      } ${className ?? ''}`
        .replace(/\s+/g, ' ')
        .trim(),
      role: 'textbox',
      'aria-label': ariaLabel ?? '',
      ...(ariaInvalid !== undefined ? { 'aria-invalid': String(ariaInvalid) } : {}),
      ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
      'aria-multiline': multiline ? 'true' : 'false',
      'data-pane-drop-target': 'node-chip',
    },
    // dragover must preventDefault or the browser never fires `drop` here.
    // `data-chip-drag-over` lets the host style a drop highlight.
    handleDOMEvents: {
      drop: (_view, event) => {
        // Run before ProseMirror parses HTML/plain text into a slice. Browsers
        // can export a rendered preview's SVG URI as hundreds of KB of text.
        // Keep regular images, code, node chips and external file drops intact.
        if (!event.dataTransfer || !isMermaidPreviewDrop(event.dataTransfer)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      keydown: (_view, event) => {
        // Slash menu owns the keyboard while open; mention search
        // next. Both return false when the key isn't theirs so the
        // editor still sees normal typing.
        if (slashStateRef.current) {
          const handled = slashMenuRef.current?.handleKeyDown(event) ?? false;
          if (handled) return true;
        }
        if (!mentionStateRef.current) return false;
        return mentionSearchRef.current?.handleKeyDown?.(event as KeyboardEvent) ?? false;
      },
      blur: () => {
        window.setTimeout(() => {
          setMentionState(null);
          setSlashState(null);
        }, 120);
        return false;
      },
      // A read-only editor refuses the drag (ProseMirror would not run the
      // drop either), so the browser shows no drop target.
      dragenter: (view, event) => {
        if (!view.editable || !event.dataTransfer || !hasChipDragData(event.dataTransfer))
          return false;
        event.preventDefault();
        view.dom.setAttribute('data-chip-drag-over', 'true');
        return false;
      },
      dragover: (view, event) => {
        if (!view.editable || !event.dataTransfer || !hasChipDragData(event.dataTransfer))
          return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        view.dom.setAttribute('data-chip-drag-over', 'true');
        return false;
      },
      dragleave: (view, event) => {
        // Only clear when leaving the editor entirely (not on
        // every child crossing).
        const related = event.relatedTarget as Node | null;
        if (related && view.dom.contains(related)) return false;
        view.dom.removeAttribute('data-chip-drag-over');
        return false;
      },
    },
    // A sidebar drag inserts one chip per row, in selection order, with the
    // caret after the last (so typing continues at the drop, not wherever
    // the caret was); rows with no chip form are skipped (with a toast).
    handleDrop: (view, event) => {
      view.dom.removeAttribute('data-chip-drag-over');
      // A chip dragged within this editor is ProseMirror's own move (the
      // chip's dragstart set `view.dragging`); inserting it here as well
      // would leave the original behind.
      if (view.dragging) return false;
      if (!event.dataTransfer || !hasChipDragData(event.dataTransfer)) return false;
      const list = readChipDragList(event.dataTransfer);
      if (!list) return false;
      event.preventDefault();
      const chips = acceptDroppedChips(list);
      if (chips.length === 0) return true;
      const coords = { left: event.clientX, top: event.clientY };
      const dropPos = view.posAtCoords(coords)?.pos ?? view.state.selection.from;
      const tr = view.state.tr.insert(dropPos, droppedChipNodes(view.state.schema, chips));
      // `near` steps back inside the paragraph the fitter may have
      // wrapped the chips in when the drop landed between blocks.
      const end = tr.mapping.map(dropPos);
      view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1)));
      view.focus();
      return true;
    },
    // Enter variants are handled by `submitExtension` (priority 1000, ahead
    // of StarterKit's Paragraph keymap). Chip toggle clicks are handled by
    // `ChipNodeView`.
  };
}
