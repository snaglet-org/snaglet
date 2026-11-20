import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from 'react';
import { toggleMarkdownCheckbox } from '@desktop/utils/toggleMarkdownCheckbox';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { useTransclusionGuard } from '@desktop/features/rich-markdown/renderer/transclusions';
import {
  filePathToChipHref,
  hasTableRowLinkByName,
} from '@desktop/features/rich-markdown/renderer/nodeRef';
import { ensureTableNames, tableNamesLoaded } from '@desktop/features/database/tableNameCache';
import { type PaletteFileNodeItem } from '@desktop/utils/api/palette-search';
import {
  acceptDroppedChips,
  chipHrefForNode,
  hasChipDragData,
  nodeToChipMarkdown,
  readChipDragList,
  toggleChipIncludeInMarkdown,
} from '@desktop/utils/nodeChip';
import {
  insertDroppedPathsAtPos,
  registerNativeFileDropTarget,
} from '@desktop/utils/nativeFileDrop';
import {
  NodeMentionSearch,
  agentChipTitle,
  titleForMentionHit,
  type AgentMentionHit,
  type NodeMentionHit,
  type NodeMentionSearchHandle,
} from './NodeMentionSearch';
import {
  agentsLoadFailed,
  ensureAgents,
  getAgentsCached,
  refreshAgents,
  subscribeAgentRoster,
} from './agentMentionCache';
import { chipKnownAgentLinks } from './chipEditableInput.agentLinks';
import type { SnagletAgent } from '@snaglet/shared/types';
import { docToMarkdown, markdownToDoc } from './markdown';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';
import { SlashMenu, type SlashCommand, type SlashMenuHandle } from './SlashMenu';
import { useFormatContextMenu } from './FormatContextMenu';
import {
  activeMentionAtSelection,
  activeSlashAtSelection,
  applyMentionDismissLatch,
  createMentionDismissLatch,
  latchMentionDismissal,
  selectionAcrossReplace,
  type MentionState,
  type SlashState,
} from './chipEditableInput.helpers';
import { autoCompleteAgent, autoCompleteFilePath } from './chipEditableInput.autocomplete';
import { buildChipEditableExtensions, createSubmitExtension } from './chipEditableInput.extensions';
import { createChipEditorProps } from './chipEditableInput.editorProps';
import { useTableDialog } from './useTableDialog';
import type { ChipEditableInputProps, Mode } from './chipEditableInput.types';
import styles from './ChipEditableInput.module.scss';

export type { ChipEditableInputProps } from './chipEditableInput.types';

/**
 * Controlled markdown input built on TipTap that renders chip refs
 * (`[Title](doc-…)`, `![](doc-…)`) as inline pills. Single-line unless
 * `multiline`. Dropped chips become chip nodes at the drop point; a file or
 * folder dropped from the OS inserts its absolute path as text (see
 * `@desktop/utils/nativeFileDrop` for where native drops are enabled).
 */
export const ChipEditableInput: FC<ChipEditableInputProps> = ({
  value,
  onChange,
  placeholder,
  multiline = false,
  disabled,
  autoFocus,
  className,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  onSubmit,
  submitOnEnter = false,
  allowInlineParse = false,
  allowMarkdownPreview = false,
  passIdOnly = false,
  defaultMode = 'edit',
  enableNodeMentions = true,
  threadId,
  mentionKinds,
  mentionOnType = false,
  richBlocks = false,
  onCheckboxAutoSave,
  topRightSlot,
  onEditorReady,
  keepSelectionOnExternalChange = false,
}) => {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [slashState, setSlashState] = useState<SlashState | null>(null);
  const [agentMentionVersion, setAgentMentionVersion] = useState(0);
  // Roster refetched each time the mention popover opens. Kept separate from
  // `agentMentionVersion`, which rebuilds the doc and resets the caret; this
  // only feeds the options memo, so a refresh never touches the document.
  const [mentionRoster, setMentionRoster] = useState<SnagletAgent[] | null>(null);
  // The roster could not be loaded (its retries used up): the popover says so.
  const [agentsUnavailable, setAgentsUnavailable] = useState(false);
  const mentionStateRef = useRef<MentionState | null>(null);
  // Remembers the `@`-token the user dismissed (Escape / click-away) so the
  // popover stays closed for it instead of reopening on the next keystroke.
  const mentionDismissLatchRef = useRef(createMentionDismissLatch());
  // The same latch for a `/` token the user dismissed with Escape, so the
  // next keystroke in it does not reopen the block menu.
  const slashDismissLatchRef = useRef(createMentionDismissLatch());
  const slashStateRef = useRef<SlashState | null>(null);
  const mentionSearchRef = useRef<NodeMentionSearchHandle | null>(null);
  const slashMenuRef = useRef<SlashMenuHandle | null>(null);
  const enableNodeMentionsRef = useRef(enableNodeMentions);
  const mentionOnTypeRef = useRef(mentionOnType);
  const richBlocksRef = useRef(richBlocks);
  const disabledRef = useRef(disabled);
  const keepSelectionRef = useRef(keepSelectionOnExternalChange);
  const filePathResolutionCacheRef = useRef<Map<string, PaletteFileNodeItem | null>>(new Map());
  const pendingFilePathResolutionsRef = useRef<Set<string>>(new Set());
  const appliedAgentMentionVersionRef = useRef(0);
  const pendingAgentMentionRetryRef = useRef(false);
  const autoFocusedEditorRef = useRef<Editor | null>(null);

  // An empty field opens in edit mode rather than a blank preview. Rich mode
  // has no preview pane.
  const canPreview = !richBlocks && allowMarkdownPreview && value.trim().length > 0;
  const effectiveMode: Mode = canPreview ? mode : 'edit';

  // Refs so the submit-keymap extension (created once, lives for the
  // editor's lifetime) always reads the *current* prop values without
  // forcing an editor recreate on every render.
  const onSubmitRef = useRef(onSubmit);
  const multilineRef = useRef(multiline);
  const submitOnEnterRef = useRef(submitOnEnter);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
    multilineRef.current = multiline;
    submitOnEnterRef.current = submitOnEnter;
    enableNodeMentionsRef.current = enableNodeMentions;
    mentionOnTypeRef.current = mentionOnType;
    richBlocksRef.current = richBlocks;
    disabledRef.current = disabled;
    keepSelectionRef.current = keepSelectionOnExternalChange;
  });

  useEffect(() => {
    mentionStateRef.current = mentionState;
  }, [mentionState]);

  useEffect(() => {
    slashStateRef.current = slashState;
  }, [slashState]);

  useEffect(() => {
    if (!value.includes('@')) return;
    // Re-parse once when a doc with `@Name` text loaded before the agent list,
    // so the text upgrades to a chip. With the cache already loaded, skip:
    // agent chips serialize to `@Name`, and a bump on every keystroke would
    // rebuild the doc and reset the caret on every key.
    if (getAgentsCached()) return;
    let canceled = false;
    void ensureAgents().then(() => {
      // A failed load has nothing to upgrade the text with.
      if (!canceled && getAgentsCached()) setAgentMentionVersion((version) => version + 1);
    });
    return () => {
      canceled = true;
    };
  }, [value]);

  // The same one-time upgrade for a row linked by its table's name
  // (`[Title](tasks:<uuid>)`): it parses as a chip only once the table
  // catalog has loaded, so a doc hydrated before that re-parses once.
  useEffect(() => {
    if (tableNamesLoaded() || !hasTableRowLinkByName(value)) return;
    let canceled = false;
    void ensureTableNames().then(() => {
      // A failed load leaves the links as they are; re-parsing would change nothing.
      if (!canceled && tableNamesLoaded()) setAgentMentionVersion((version) => version + 1);
    });
    return () => {
      canceled = true;
    };
  }, [value]);

  const updateSlashState = useCallback((ed: Editor) => {
    if (!richBlocksRef.current || disabledRef.current) {
      setSlashState(null);
      return;
    }
    setSlashState(
      applyMentionDismissLatch(slashDismissLatchRef.current, activeSlashAtSelection(ed))
    );
  }, []);

  const updateMentionState = useCallback((ed: Editor) => {
    if (!enableNodeMentionsRef.current || disabledRef.current) {
      setMentionState(null);
      return;
    }
    // A dismissed token stays closed until it's gone or a fresh `@` is typed.
    const next = applyMentionDismissLatch(
      mentionDismissLatchRef.current,
      activeMentionAtSelection(ed, { onType: mentionOnTypeRef.current })
    );
    // Refetch agents when the popover opens, so it offers agents created
    // since the cache loaded and typed-mention autocomplete has them. The
    // cached roster shows at once; the fresh one replaces it on arrival.
    if (next && !mentionStateRef.current) {
      void refreshAgents().then((roster) => {
        setMentionRoster(roster);
        setAgentsUnavailable(agentsLoadFailed());
      });
    }
    setMentionState(next);
  }, []);

  // Typed-mention and file-path autocomplete (`chipEditableInput.autocomplete.ts`),
  // given refs so they read current values without recreating the editor.
  const tryAutoCompleteAgent = useCallback(
    (ed: Editor): boolean =>
      autoCompleteAgent(ed, {
        enableNodeMentionsRef,
        disabledRef,
        pendingAgentMentionRetryRef,
      }),
    []
  );

  const tryAutoCompleteFilePath = useCallback(
    (ed: Editor): boolean =>
      autoCompleteFilePath(ed, {
        disabledRef,
        filePathResolutionCacheRef,
        pendingFilePathResolutionsRef,
      }),
    []
  );

  // Enter keymap (see `createSubmitExtension`). Created once; it reads props
  // through refs so a prop change never recreates the editor.
  const submitExtension = useMemo(
    () =>
      createSubmitExtension({
        onSubmitRef,
        multilineRef,
        submitOnEnterRef,
        richBlocksRef,
        mentionStateRef,
        slashStateRef,
      }),
    []
  );

  // A 2px drop caret for tree and chip drags. The plugin sets its color
  // inline, so `color: false` leaves styling to the `snaglet-dropcursor` class.
  const dropcursorConfig = useMemo(
    () => ({ width: 2, color: false as const, class: 'snaglet-dropcursor' }),
    []
  );

  const extensions = useMemo(
    () =>
      buildChipEditableExtensions({
        submitExtension,
        richBlocks,
        dropcursorConfig,
        multiline,
        allowInlineParse,
        placeholder,
      }),
    // `passIdOnly` is not a dep: it only affects serialization, and since
    // `useEditor` is keyed on `[extensions]`, listing it would recreate the
    // editor (losing caret, undo and focus) when it flips.
    [allowInlineParse, dropcursorConfig, multiline, placeholder, richBlocks, submitExtension]
  );

  const editor = useEditor(
    {
      extensions,
      content: '',
      // Focus after hydration below. TipTap's timer + animation-frame focus
      // leaves the first keystroke aimed at the cell's former trigger.
      autofocus: false,
      editable: !disabled,
      immediatelyRender: false,
      // Paste, drag/drop and DOM events live in `createChipEditorProps`;
      // Enter variants belong to `submitExtension` above.
      editorProps: createChipEditorProps({
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
      }),
      onUpdate: ({ editor: ed }) => {
        // Try typed-mention autocomplete first. If it modifies the doc,
        // TipTap fires `onUpdate` again with the post-replacement state —
        // we let that second pass handle `onChange` / state cleanup so
        // the host never sees the un-pilled intermediate markdown.
        if (tryAutoCompleteAgent(ed)) return;
        if (tryAutoCompleteFilePath(ed)) return;
        onChange(
          richBlocks ? docToRichMarkdown(ed, { passIdOnly }) : docToMarkdown(ed, { passIdOnly })
        );
        updateMentionState(ed);
        updateSlashState(ed);
      },
      onSelectionUpdate: ({ editor: ed }) => {
        updateMentionState(ed);
        updateSlashState(ed);
      },
    },
    // Re-create the editor when extensions identity changes (i.e. when
    // a config flag flips), since extensions can't be swapped on the fly.
    [extensions]
  );

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // An agent created or restored after this document was parsed: its
  // `[Name](agent-id)` links become chips as soon as the shared roster has it.
  // Load the roster too: a doc whose agent references are all links has no
  // `@` to trigger the load above, and its links chip only once it arrives.
  useEffect(() => {
    if (!editor || !richBlocks) return;
    const stop = subscribeAgentRoster(() => {
      // A replacement mid-composition would break the IME's input.
      if (!editor.isDestroyed && !editor.view.composing) chipKnownAgentLinks(editor);
    });
    if (!getAgentsCached()) void ensureAgents();
    return stop;
  }, [editor, richBlocks]);

  // Extension-keyed editors keep their initial options. Validation changes
  // must reach the existing view without recreating it and losing selection.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const previous = editor.options.editorProps.attributes;
    const attributes = { ...(typeof previous === 'function' ? previous(editor.state) : previous) };
    if (ariaInvalid === undefined) delete attributes['aria-invalid'];
    else attributes['aria-invalid'] = String(ariaInvalid);
    if (ariaDescribedBy) attributes['aria-describedby'] = ariaDescribedBy;
    else delete attributes['aria-describedby'];
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes } });
  }, [editor, ariaInvalid, ariaDescribedBy]);

  // External value sync. Only repaint when the incoming prop differs
  // from what the editor would currently serialize — re-rendering on
  // every onChange round-trip would blow away the caret.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const current = richBlocks
      ? docToRichMarkdown(editor, { passIdOnly })
      : docToMarkdown(editor, { passIdOnly });
    if (current === value && appliedAgentMentionVersionRef.current === agentMentionVersion) return;
    // Bare ids always load as chips, as `remarkBareNodeRefs` does in the
    // preview. `passIdOnly` stores a table chip as its bare catalog id, so
    // that must also read back as a chip.
    const parseOptions = { parseBareIds: true, parseBareTableIds: passIdOnly };
    const nextDoc = richBlocks
      ? richMarkdownToDoc(value, editor.schema, parseOptions)
      : markdownToDoc(value, editor.schema, parseOptions);
    // Defer out of the React commit phase: setContent mounts chip node
    // views, and ReactNodeViewRenderer flushSync-es inside a lifecycle
    // otherwise (console error spam on chip-heavy docs).
    // Loading a value is not a user edit: keep it out of undo history so
    // Cmd+Z can't step back to the empty mount or a replaced value.
    let canceled = false;
    queueMicrotask(() => {
      if (canceled || editor.isDestroyed) return;
      // setContent leaves the caret at the end. A reload under the user's
      // caret (a save from another client) keeps it on the same text instead.
      const kept = keepSelectionRef.current && editor.isFocused ? editor.state.selection : null;
      editor
        .chain()
        .setMeta('addToHistory', false)
        .setContent(nextDoc, { emitUpdate: false })
        .command(({ tr }) => {
          if (kept) tr.setSelection(selectionAcrossReplace(tr.before, tr.doc, kept));
          return true;
        })
        .run();
      // `nextDoc` was parsed before this microtask: a roster that changed in
      // between would leave its agent links plain.
      if (richBlocks) chipKnownAgentLinks(editor);
      appliedAgentMentionVersionRef.current = agentMentionVersion;
    });
    // A newer prop may match the current document and need no hydration of
    // its own. It must still invalidate this pending, older replacement.
    return () => {
      canceled = true;
    };
  }, [editor, value, passIdOnly, richBlocks, agentMentionVersion]);

  useLayoutEffect(() => {
    if (!editor || !autoFocus || disabled || autoFocusedEditorRef.current === editor) return;
    autoFocusedEditorRef.current = editor;
    const origin = document.activeElement;
    // The preceding hydration microtask mounts chip views outside React's
    // commit. Focus immediately after it, before the next native input event,
    // instead of scheduling an animation frame that can lose early typing.
    queueMicrotask(() => {
      if (editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected) return;
      const active = document.activeElement;
      if (active !== origin && active !== document.body && active !== editor.view.dom) return;
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.view.focus();
    });
  }, [editor, autoFocus, disabled]);

  // Disabled state can change mid-form (e.g. while saving). Mirror it
  // onto the editor so the host can toggle without remounting.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable === !disabled) return;
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  // Native OS file/folder drop inserts the absolute path(s) as text at the
  // drop point. It arrives on a separate channel from chip drags (see
  // nativeFileDropRegistry), and re-registers only when the editor is
  // recreated.
  useEffect(() => {
    if (!editor) return;

    let unregister: (() => void) | undefined;
    const attach = (): void => {
      if (editor.isDestroyed) return;
      unregister = registerNativeFileDropTarget({
        el: editor.view.dom,
        onDrop: (pathsText, clientPos) => {
          if (editor.isDestroyed) return;
          const coords = editor.view.posAtCoords({ left: clientPos.x, top: clientPos.y });
          const pos = coords?.pos ?? editor.state.selection.from;
          insertDroppedPathsAtPos(editor, pathsText, pos);
        },
      });
    };

    // `editor.view` throws until the view mounts, and this effect can run
    // first (e.g. inside a collapsed disclosure). `isInitialized` flips a
    // tick after `create`, so use the event before mount and the flag after;
    // exactly one branch attaches.
    if (editor.isInitialized) attach();
    else editor.on('create', attach);

    return () => {
      editor.off('create', attach);
      unregister?.();
    };
  }, [editor]);

  const insertMentionHit = useCallback(
    (hit: NodeMentionHit) => {
      if (!editor || editor.isDestroyed || !mentionState) return;

      // Trigger hits are supplied only by code-editor callers. This rich
      // editor never opts into that lane, but the shared union stays explicit.
      if (hit.type === 'trigger') return;

      if (hit.type === 'filesystem') {
        editor
          .chain()
          .focus()
          .insertContentAt(
            { from: mentionState.range.from, to: mentionState.range.to },
            `${hit.filesystem.path} `
          )
          .run();
        setMentionState(null);
        return;
      }

      const chipType = editor.state.schema.nodes.chip;
      if (!chipType) return;

      // Agents and workspace nodes use their ids; file nodes use a
      // path-backed href so the markdown keeps the file path.
      let chip;
      if (hit.type === 'agent') {
        chip = chipType.create({
          href: hit.agent.id,
          title: agentChipTitle(hit),
          include: false,
          kind: 'agent',
        });
      } else if (hit.type === 'entry') {
        // A row chip: `entry:<table catalog id>/<row uuid>`.
        chip = chipType.create({
          href: `entry:${hit.entry.tableId}/${hit.entry.entryId}`,
          title: titleForMentionHit(hit),
          include: false,
          kind: 'entry',
        });
      } else if (hit.type === 'file-node') {
        chip = chipType.create({
          // Absolute path: the server can't locate a project-relative one.
          href: filePathToChipHref(hit.file.absolutePath),
          title: titleForMentionHit(hit),
          include: false,
          kind: 'file',
        });
      } else if (hit.workspace.nodeType === 'table') {
        // A catalog id is not a node id: table chips take the `table:` href.
        chip = chipType.create({
          href: chipHrefForNode({ id: hit.workspace.nodeId, kind: 'table' }),
          title: titleForMentionHit(hit),
          include: false,
          kind: 'table',
        });
      } else {
        chip = chipType.create({
          href: hit.workspace.nodeId,
          title: titleForMentionHit(hit),
          include: false,
          kind: hit.workspace.nodeType,
        });
      }

      editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          tr.delete(mentionState.range.from, mentionState.range.to);
          tr.insert(mentionState.range.from, chip);
          tr.insertText(' ', mentionState.range.from + chip.nodeSize);
          dispatch?.(tr.scrollIntoView());
          return true;
        })
        .run();
      setMentionState(null);
    },
    [editor, mentionState]
  );

  const pickSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (!editor || editor.isDestroyed || !slashState) return;
      // Remove the typed `/query`, then run the block command. A space typed
      // before the slash goes too when nothing but the line end or another
      // space follows, so `hello /h2` leaves `hello`, not `hello `.
      const { doc } = editor.state;
      const { from, to } = slashState.range;
      const $to = doc.resolve(to);
      const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, '\n', '\n');
      const before = from > $to.start() ? doc.textBetween(from - 1, from) : '';
      const start = before === ' ' && (after === '' || after.startsWith(' ')) ? from - 1 : from;
      editor.chain().focus().deleteRange({ from: start, to }).run();
      command.run(editor);
      setSlashState(null);
    },
    [editor, slashState]
  );

  const formatMenu = useFormatContextMenu(richBlocks ? editor : null, Boolean(disabled));
  // A table's Expand opens it large (rich mode is the only one with tables).
  const richHostRef = useRef<HTMLDivElement>(null);
  const tableDialog = useTableDialog(editor, richHostRef);

  const slashPopover =
    richBlocks && slashState && !disabled ? (
      <SlashMenu
        ref={slashMenuRef}
        query={slashState.query}
        anchor={slashState.anchor}
        editor={editor}
        onPick={pickSlashCommand}
        onClose={() => setSlashState(null)}
        onDismiss={() => {
          latchMentionDismissal(slashDismissLatchRef.current, slashState);
          setSlashState(null);
        }}
      />
    ) : null;

  // Agent options for the mention popover; Enter on an exact agent name
  // commits the agent from this list. Refreshes when the cache loads
  // (`agentMentionVersion`) and when the popover refetches (`mentionRoster`).
  const mentionAgentOptions = useMemo<AgentMentionHit[]>(() => {
    agentMentionVersion;
    const cached = mentionRoster ?? getAgentsCached() ?? [];
    return cached.map((agent) => ({
      type: 'agent' as const,
      key: agent.id,
      label: agent.name || 'Agent',
      subtitle: agent.role ?? null,
      prefix: false,
      agent: {
        id: agent.id,
        name: agent.name ?? null,
        handle: null,
        role: agent.role ?? null,
      },
    }));
  }, [agentMentionVersion, mentionRoster]);

  const mentionPopover =
    enableNodeMentions && effectiveMode === 'edit' && mentionState ? (
      <NodeMentionSearch
        ref={mentionSearchRef}
        open
        query={mentionState.query}
        anchorRect={mentionState.anchor}
        threadId={threadId}
        agentOptions={mentionAgentOptions}
        agentsUnavailable={agentsUnavailable}
        onlyKinds={mentionKinds}
        onSelect={insertMentionHit}
        onClose={() => {
          // Explicit dismissal (Escape / click-away): latch this `@`-token so
          // continued typing doesn't re-open the same search.
          latchMentionDismissal(mentionDismissLatchRef.current, mentionState);
          setMentionState(null);
        }}
      />
    ) : null;

  // Preview chip-toggle click: flip every chip with that href in the
  // source markdown. Turning a link into a transclusion that would loop is
  // refused with a notice.
  const allowTransclusion = useTransclusionGuard();
  // The latest value and onChange, for work that finishes after a round trip
  // (the transclusion check) and must not drop what was typed meanwhile.
  const previewValueRef = useRef(value);
  const previewOnChangeRef = useRef(onChange);
  useEffect(() => {
    previewValueRef.current = value;
    previewOnChangeRef.current = onChange;
  });
  const onPreviewClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      const target = e.target as Element;
      const toggle = target.closest?.('.md-chip-toggle');
      if (!toggle) return;
      e.preventDefault();
      e.stopPropagation();
      const href =
        toggle.closest('a.md-chip')?.getAttribute('href') ??
        toggle.closest('span.md-chip')?.getAttribute('data-node-url');
      if (!href) return;
      if (toggle.getAttribute('data-toggle-direction') !== 'include') {
        onChange(toggleChipIncludeInMarkdown(value, href));
        return;
      }
      void allowTransclusion(href).then((allowed) => {
        if (!allowed) return;
        previewOnChangeRef.current(toggleChipIncludeInMarkdown(previewValueRef.current, href));
      });
    },
    [allowTransclusion, disabled, onChange, value]
  );

  // Chip drop on the preview pane. Rendered HTML has no caret to target, so
  // the chip markdown (`[Title](href)`, or `![](href)` when Shift asked for
  // an include) is appended to the body, one per dragged row. A disabled
  // preview refuses the drag.
  const onPreviewDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !e.dataTransfer || !hasChipDragData(e.dataTransfer)) return;
      e.preventDefault();
      e.currentTarget.setAttribute('data-chip-drag-over', 'true');
    },
    [disabled]
  );
  const onPreviewDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !e.dataTransfer || !hasChipDragData(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      e.currentTarget.setAttribute('data-chip-drag-over', 'true');
    },
    [disabled]
  );
  const onPreviewDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    e.currentTarget.removeAttribute('data-chip-drag-over');
  }, []);
  const onPreviewDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.currentTarget.removeAttribute('data-chip-drag-over');
      if (disabled || !e.dataTransfer || !hasChipDragData(e.dataTransfer)) return;
      const list = readChipDragList(e.dataTransfer);
      if (!list) return;
      e.preventDefault();
      const chips = acceptDroppedChips(list);
      if (chips.length === 0) return;
      const chipMd = chips.map((chip) => nodeToChipMarkdown(chip, { include: false })).join(' ');
      const separator = value.length === 0 || /\s$/.test(value) ? '' : '\n\n';
      onChange(`${value}${separator}${chipMd}`);
    },
    [disabled, onChange, value]
  );

  // Native OS file drop on the preview pane appends the path(s), like chips
  // above. Refs keep the callback ref stable, so registration follows the
  // preview div mounting rather than every keystroke.
  const previewNativeDropUnregisterRef = useRef<(() => void) | null>(null);
  const registerPreviewNativeDropEl = useCallback((el: HTMLDivElement | null) => {
    previewNativeDropUnregisterRef.current?.();
    previewNativeDropUnregisterRef.current = null;
    if (!el) return;
    previewNativeDropUnregisterRef.current = registerNativeFileDropTarget({
      el,
      onDrop: (pathsText) => {
        if (disabledRef.current) return;
        const current = previewValueRef.current;
        const separator = current.length === 0 || /\s$/.test(current) ? '' : '\n\n';
        previewOnChangeRef.current(`${current}${separator}${pathsText}`);
      },
    });
  }, []);

  // Rich mode: one always-editable surface with no preview. The mode row
  // only holds the host's `topRightSlot`. Right-click opens the format menu.
  if (richBlocks) {
    return (
      <div
        ref={richHostRef}
        className={styles.previewHost}
        onContextMenu={formatMenu.onContextMenu}
      >
        {topRightSlot ? <div className={styles.modeRow}>{topRightSlot}</div> : null}
        <EditorContent editor={editor} />
        {slashPopover}
        {mentionPopover}
        {formatMenu.element}
        {tableDialog}
      </div>
    );
  }

  if (!allowMarkdownPreview) {
    return (
      <>
        <EditorContent editor={editor} />
        {mentionPopover}
      </>
    );
  }

  return (
    <div className={styles.previewHost}>
      <div className={styles.modeRow}>
        {topRightSlot}
        <button
          type="button"
          className={styles.modeToggle}
          onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
          disabled={!canPreview}
          title={effectiveMode === 'edit' ? 'Show rendered preview' : 'Back to editor'}
        >
          <span className={effectiveMode === 'edit' ? styles.modeActive : undefined}>edit</span>
          <span className={styles.modeSlash}>/</span>
          <span className={effectiveMode === 'preview' ? styles.modeActive : undefined}>
            preview
          </span>
        </button>
      </div>
      {effectiveMode === 'preview' ? (
        <div
          ref={registerPreviewNativeDropEl}
          className={`${styles.preview} ${className ?? ''}`.trim()}
          // Mirror the edit pane's drop-target attribute so panes that
          // listen for `data-pane-drop-target="node-chip"` (chrome,
          // outer drop zones) also accept drops onto the preview.
          data-pane-drop-target="node-chip"
          onClick={onPreviewClick}
          onDragEnter={onPreviewDragEnter}
          onDragOver={onPreviewDragOver}
          onDragLeave={onPreviewDragLeave}
          onDrop={onPreviewDrop}
          onDoubleClick={() => {
            setMode('edit');
            // Focus after the next paint, once the editor element is mounted.
            requestAnimationFrame(() => editor?.commands.focus('end'));
          }}
        >
          {/* Read-only (disabled): checkboxes render inert, and chips carry
              no include toggle. */}
          <MarkdownRenderer
            content={value}
            showIncludeToggle={!disabled}
            onConvertIncludeToLink={
              disabled
                ? undefined
                : (href, liveTitle) => onChange(toggleChipIncludeInMarkdown(value, href, liveTitle))
            }
            onCheckboxToggle={
              disabled
                ? undefined
                : (sourceOffset) => {
                    const updated = toggleMarkdownCheckbox(value, sourceOffset);
                    if (onCheckboxAutoSave) {
                      onCheckboxAutoSave(updated);
                    } else {
                      onChange(updated);
                    }
                  }
            }
          />
        </div>
      ) : (
        <>
          <EditorContent editor={editor} />
          {mentionPopover}
        </>
      )}
    </div>
  );
};
