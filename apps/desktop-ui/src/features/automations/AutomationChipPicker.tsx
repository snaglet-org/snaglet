/**
 * One-chip pickers for the New automation form (who wakes, and where), on the
 * shared chip editor: type (or `@`) to search that one kind, pick a result,
 * Backspace removes it. A pasted id or link, a typed id (on Enter or when the
 * field loses focus) and a sidebar drop all land as the same chip, looked up
 * through `resolve` before the form counts it. A drop of another kind is
 * refused with a short note.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { PaletteNodeKind } from '@snaglet/shared';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { docToMarkdown, markdownToDoc } from '@desktop/features/rich-markdown/editor/markdown';
import { parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { agentMentionMarkdown } from '@desktop/utils/agentMentionMarkdown';
import {
  hasChipDragData,
  nodeTitle,
  nodeToChipMarkdown,
  readChipDragData,
} from '@desktop/utils/nodeChip';
import styles from './AutomationChipFields.module.scss';

export interface ChipPick {
  id: string;
  title: string;
}

export type ChipPickerKind = 'agent' | 'thread';

const SEARCH_KINDS: Record<ChipPickerKind, readonly PaletteNodeKind[]> = {
  agent: ['agent'],
  thread: ['thread'],
};

const COPY: Record<ChipPickerKind, { drop: string; wrong: string; looking: string }> = {
  agent: {
    drop: 'Drop an agent here',
    wrong: "That isn't an agent.",
    looking: 'Looking up the agent…',
  },
  thread: {
    drop: 'Drop a thread here',
    wrong: "That isn't a thread.",
    looking: 'Looking up the thread…',
  },
};

export interface AutomationChipPickerProps {
  kind: ChipPickerKind;
  label: string;
  value: ChipPick | null;
  onChange: (next: ChipPick | null) => void;
  /** Look a chip up before it counts; throw to refuse it (the message shows). */
  resolve?: (id: string) => Promise<ChipPick>;
  /** Typed text that names one of this kind (an id or a link), as its id. */
  idFromText?: (text: string) => string | null;
  placeholder: string;
  hint?: ReactNode;
  /** A problem with the pick that the form knows about. */
  problem?: string | null;
  disabled?: boolean;
}

interface ChipInDoc {
  href: string;
  title: string;
  kind: string;
}

function chipsIn(editor: Editor): ChipInDoc[] {
  const chips: ChipInDoc[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'chip') return;
    chips.push({
      href: String(node.attrs.href ?? ''),
      title: String(node.attrs.title ?? ''),
      kind: String(node.attrs.kind ?? ''),
    });
  });
  return chips;
}

function typedText(editor: Editor): string {
  let text = '';
  editor.state.doc.descendants((node) => {
    if (node.isText) text += node.text ?? '';
  });
  return text.trim();
}

/** A chip's id: agents are their href; node chips may carry a `kind:` scheme. */
function chipId(chip: ChipInDoc): string {
  if (chip.kind === 'agent') return chip.href;
  return parseNodeRef(chip.href)?.id ?? chip.href;
}

const CHIP_LINK_RE = /^\[(?:\\.|[^\]\\])*\]\(([^)\s]+)\)$/;

/**
 * The thread a typed or pasted text names: its id (`thread-…`, or the
 * `thread:` scheme form) or a link to it (`[Title](thread-…)`, what Copy link
 * and agents write). Anything else is null.
 */
export function threadIdFromText(text: string): string | null {
  const trimmed = text.trim();
  const href = CHIP_LINK_RE.exec(trimmed)?.[1] ?? trimmed;
  const ref = parseNodeRef(href);
  return ref?.kind === 'thread' ? ref.id : null;
}

function chipMarkdown(kind: ChipPickerKind, pick: ChipPick): string {
  // Matches what the editor serializes an agent chip to, so it is not re-set.
  if (kind === 'agent') return agentMentionMarkdown(pick.title);
  return nodeToChipMarkdown({ id: pick.id, kind, title: pick.title });
}

export function AutomationChipPicker({
  kind,
  label,
  value,
  onChange,
  resolve,
  idFromText,
  placeholder,
  hint,
  problem,
  disabled = false,
}: AutomationChipPickerProps) {
  const noteId = useId();
  const editorRef = useRef<Editor | null>(null);
  const [markdown, setMarkdown] = useState(() => (value ? chipMarkdown(kind, value) : ''));
  // The pick the field shows (or is looking up), and the last one sent up.
  const shownRef = useRef<ChipPick | null>(value);
  const sentIdRef = useRef<string | null>(value?.id ?? null);
  const requestRef = useRef(0);
  const [note, setNote] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // The value last handed to the editor. The editor re-syncs only when that
  // changes, so putting back the value it already had needs a direct reset.
  const renderedRef = useRef(markdown);
  useEffect(() => {
    renderedRef.current = markdown;
  }, [markdown]);

  const show = useCallback(
    (pick: ChipPick | null) => {
      shownRef.current = pick;
      const next = pick ? chipMarkdown(kind, pick) : '';
      setMarkdown(next);
      const editor = editorRef.current;
      if (!editor || next !== renderedRef.current) return;
      // Out of the edit that is being refused, like the editor's own sync.
      queueMicrotask(() => {
        if (editor.isDestroyed || docToMarkdown(editor) === next) return;
        const doc = markdownToDoc(next, editor.schema, { parseBareIds: true });
        editor.chain().setMeta('addToHistory', false).setContent(doc, { emitUpdate: false }).run();
      });
    },
    [kind]
  );

  const send = useCallback(
    (pick: ChipPick | null) => {
      sentIdRef.current = pick?.id ?? null;
      onChange(pick);
    },
    [onChange]
  );

  // The form picked or cleared one itself (e.g. the agent's only thread).
  useEffect(() => {
    const id = value?.id ?? null;
    if (id === sentIdRef.current) return;
    sentIdRef.current = id;
    requestRef.current += 1;
    setLooking(false);
    show(value);
  }, [show, value]);

  const accept = useCallback(
    async (candidate: ChipPick) => {
      const previous = shownRef.current;
      const request = ++requestRef.current;
      setNote(null);
      show(candidate);
      if (!resolve) {
        send(candidate);
        return;
      }
      // Nothing counts while it is looked up, so Create cannot use a stale pick.
      send(null);
      setLooking(true);
      try {
        const pick = await resolve(candidate.id);
        if (request !== requestRef.current) return;
        show(pick);
        send(pick);
      } catch (err) {
        if (request !== requestRef.current) return;
        setNote(getErrorMessage(err, `Couldn't look that ${kind} up`));
        show(previous);
        send(previous);
      } finally {
        if (request === requestRef.current) setLooking(false);
      }
    },
    [kind, resolve, send, show]
  );

  const onEditorReady = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);

  const onEdit = (next: string) => {
    setMarkdown(next);
    setNote(null);
    const editor = editorRef.current;
    if (!editor) return;
    const chips = chipsIn(editor);
    const shown = shownRef.current;
    if (chips.length === 0) {
      if (!shown) return;
      // Backspace (or a cut) took the chip out.
      requestRef.current += 1;
      setLooking(false);
      shownRef.current = null;
      send(null);
      return;
    }
    const fresh = [...chips].reverse().find((chip) => chipId(chip) !== shown?.id);
    if (!fresh) {
      // The same one picked again: keep a single chip.
      if (chips.length > 1) show(shown);
      return;
    }
    if (fresh.kind !== kind) {
      setNote(COPY[kind].wrong);
      show(shown);
      return;
    }
    void accept({ id: chipId(fresh), title: fresh.title });
  };

  // Enter, or leaving the field: typed text that names one becomes its chip;
  // stray search text next to a pick is dropped.
  const settleTyped = () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    const text = typedText(editor);
    if (!text) return;
    const id = idFromText?.(text);
    if (id) {
      void accept({ id, title: '' });
      return;
    }
    if (shownRef.current) show(shownRef.current);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    settleTyped();
  };

  // The field owns every chip drop on it (the pane must not open the node):
  // the right kind becomes the pick, anything else is refused.
  const onDragOverCapture = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasChipDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const onDropCapture = (event: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (disabled || !hasChipDragData(event.dataTransfer)) return;
    const chip = readChipDragData(event.dataTransfer);
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    if (chip.kind !== kind) {
      setNote(COPY[kind].drop);
      return;
    }
    void accept({ id: chip.id, title: nodeTitle(chip) });
  };

  const message = note ?? problem ?? null;

  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div
        className={styles.shell}
        data-drag-over={dragOver ? 'true' : undefined}
        data-pane-drop-target="node-chip"
        onBlur={onBlur}
        onDragOverCapture={onDragOverCapture}
        onDragLeave={onDragLeave}
        onDropCapture={onDropCapture}
      >
        <ChipEditableInput
          value={markdown}
          onChange={onEdit}
          onEditorReady={onEditorReady}
          onSubmit={settleTyped}
          mentionKinds={SEARCH_KINDS[kind]}
          mentionOnType
          placeholder={placeholder}
          disabled={disabled}
          ariaLabel={label}
          ariaInvalid={!!message}
          ariaDescribedBy={noteId}
          className={styles.input}
        />
      </div>
      <span
        id={noteId}
        className={message && !looking ? styles.problem : styles.hint}
        role={message && !looking ? 'alert' : undefined}
      >
        {looking ? COPY[kind].looking : (message ?? hint)}
      </span>
    </div>
  );
}
