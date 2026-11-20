/**
 * The shared CodeMirror editor for builder surfaces (tool.ts in
 * ToolBuilderPanel, hook.ts in HookBuilderPanel).
 *
 * Load this module with a dynamic import so CodeMirror stays in one lazy
 * chunk. The sibling modules (editorChip, handlerEditorSupport,
 * resolveDropInsertText) are light and safe to import statically.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript, typescriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import {
  autocompletion,
  closeCompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { handlerEditorTheme } from './handlerEditorTheme';
import { findHandlerEditorMention, snagletSdkCompletionSource } from './handlerEditorSupport';
import { isRecognizedEditorDrop, resolveDropInsertText } from './resolveDropInsertText';
import { quoteStringLiteral } from './editorChip';
import {
  NodeMentionSearch,
  type MentionTriggerOption,
  type NodeMentionHit,
  type NodeMentionSearchHandle,
} from '@desktop/features/rich-markdown/editor/NodeMentionSearch';
import styles from './HandlerEditor.module.scss';

export interface HandlerEditorProps {
  /** Current file content — controlled, mirrors a normal `<textarea value>`. */
  value: string;
  /** Fired on every doc change with the full new content. */
  onChange: (next: string) => void;
  /** Locks the document against edits (e.g. while a save is in flight). */
  readOnly?: boolean;
  /** Enables the rich editor's `@` node-search surface for this code editor. */
  enableNodeMentions?: boolean;
  /** Optional local `@trigger:` lane, sourced by the caller's runtime registry. */
  mentionTriggerOptions?: readonly MentionTriggerOption[];
  /** Enable drag-to-insert for recognized workspace/editor payloads. */
  enableDropInsert?: boolean;
  /** Let a pane-hosted editor consume all height its parent gives it. */
  fillHeight?: boolean;
  'aria-label'?: string;
}

type CodeMentionState = {
  from: number;
  to: number;
  query: string;
  anchor: { left: number; top: number; bottom: number; width: number } | null;
};

function mentionValue(hit: NodeMentionHit): string {
  if (hit.type === 'trigger') return hit.trigger;
  if (hit.type === 'agent') return hit.agent.id;
  if (hit.type === 'entry') return `entry:${hit.entry.tableId}/${hit.entry.entryId}`;
  if (hit.type === 'workspace') return hit.workspace.nodeId;
  if (hit.type === 'file-node') return hit.file.nodeId;
  return hit.filesystem.path;
}

/**
 * Imperative handle exposed via `ref` for programmatic insertion at the
 * current cursor/selection. Drag-to-insert is handled internally because it
 * needs the drop's screen coordinates, not just the current cursor.
 */
export interface HandlerEditorHandle {
  /** Replace the current selection (or insert at the cursor, when the
   *  selection is empty) with `text`, then refocus the editor. */
  insertText: (text: string) => void;
}

/**
 * A small TypeScript editor, not an IDE. The view mounts once so undo history
 * and the cursor survive; `readOnly` is reconfigured through a Compartment.
 *
 * A dropped sidebar node or editor chip inserts its id or literal here and
 * must win over the pane's split drop zone (usePaneDropZone):
 *  1. The root's onDragOver/onDrop stop propagation to the pane's handlers.
 *  2. `data-pane-drop-target="node-chip"` keeps the pane's capture handler idle.
 *  3. A Prec.highest handler preempts CodeMirror's raw text/plain drop.
 */
export const HandlerEditor = forwardRef<HandlerEditorHandle, HandlerEditorProps>(
  function HandlerEditor(
    {
      value,
      onChange,
      readOnly = false,
      enableNodeMentions = false,
      mentionTriggerOptions,
      enableDropInsert = true,
      fillHeight = false,
      'aria-label': ariaLabel = 'tool.ts handler code',
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const mentionSearchRef = useRef<NodeMentionSearchHandle | null>(null);
    const dismissedMentionFromRef = useRef<number | null>(null);
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [mentionState, setMentionState] = useState<CodeMentionState | null>(null);
    const readOnlyRef = useRef(readOnly);
    const enableNodeMentionsRef = useRef(enableNodeMentions);
    const enableDropInsertRef = useRef(enableDropInsert);
    readOnlyRef.current = readOnly;
    enableNodeMentionsRef.current = enableNodeMentions;
    enableDropInsertRef.current = enableDropInsert;

    const refreshMentionState = useCallback((view: EditorView) => {
      if (
        !enableNodeMentionsRef.current ||
        readOnlyRef.current ||
        !view.state.selection.main.empty
      ) {
        setMentionState(null);
        return;
      }
      const caret = view.state.selection.main.head;
      const line = view.state.doc.lineAt(caret);
      const active = findHandlerEditorMention(
        view.state.sliceDoc(line.from, caret),
        line.from,
        caret
      );
      if (!active) {
        dismissedMentionFromRef.current = null;
        setMentionState(null);
        return;
      }
      if (dismissedMentionFromRef.current === active.from) {
        setMentionState(null);
        return;
      }
      dismissedMentionFromRef.current = null;
      const fallback = containerRef.current?.getBoundingClientRect() ?? null;
      let caretRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null = fallback;
      try {
        caretRect = view.coordsAtPos(caret) ?? fallback;
      } catch {
        // jsdom and an editor mid-layout may not have caret geometry yet.
      }
      setMentionState({
        ...active,
        anchor: caretRect
          ? {
              left: caretRect.left,
              top: caretRect.top,
              bottom: caretRect.bottom,
              width: Math.max(1, caretRect.right - caretRect.left),
            }
          : null,
      });
    }, []);

    // A ref (not a dependency) so the update listener installed at mount time
    // always calls the latest onChange without needing to be an effect
    // dependency that would force a full remount on every render.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    // Shared by the CM-chain drop handler (mechanism 3) and the React
    // fallback below — resolves the payload and inserts the literal at the
    // drop's screen position. Stable `[]` closure; reads refs fresh.
    const insertDroppedPayload = useCallback(
      (view: EditorView, dt: DataTransfer, clientX: number, clientY: number) => {
        const text = resolveDropInsertText(dt);
        if (!text) return;
        // `posAtCoords` can throw under jsdom's zeroed-out layout; fall back
        // to the end of the doc.
        let pos: number;
        try {
          pos = view.posAtCoords({ x: clientX, y: clientY }) ?? view.state.doc.length;
        } catch {
          pos = view.state.doc.length;
        }
        view.dispatch({
          changes: { from: pos, to: pos, insert: text },
          selection: { anchor: pos + text.length },
        });
        view.focus();
      },
      []
    );

    // Per-instance compartment (not module-level) — a Compartment is tied to
    // the specific EditorState/EditorView it was installed into, so sharing
    // one across multiple HandlerEditor instances (e.g. React StrictMode's
    // double-invoke, or two builder panels mounted at once) would throw when
    // reconfiguring against the "wrong" view.
    const readOnlyCompartmentRef = useRef<Compartment>(new Compartment());

    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) return;

      const view = new EditorView({
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(),
            foldGutter(),
            history(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            indentUnit.of('  '),
            javascript({ typescript: true }),
            typescriptLanguage.data.of({ autocomplete: snagletSdkCompletionSource }),
            autocompletion(),
            EditorView.lineWrapping,
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
            handlerEditorTheme(),
            readOnlyCompartmentRef.current.of([
              EditorState.readOnly.of(readOnly),
              EditorView.editable.of(!readOnly),
            ]),
            EditorView.contentAttributes.of({ 'aria-label': ariaLabel, role: 'textbox' }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) onChangeRef.current(update.state.doc.toString());
              if (update.docChanged || update.selectionSet) refreshMentionState(update.view);
            }),
            Prec.highest(
              EditorView.domEventHandlers({
                keydown(event) {
                  return mentionSearchRef.current?.handleKeyDown?.(event) ?? false;
                },
                // Mechanism (3) in the component doc comment. Returning `true`
                // stops CodeMirror's built-in drop handler from inserting
                // the drag's raw text/plain; stopPropagation keeps the
                // React fallback on the root div (and the pane's drop zone)
                // from seeing the same event.
                dragover(event) {
                  if (!enableDropInsertRef.current || !event.dataTransfer) return false;
                  if (!isRecognizedEditorDrop(event.dataTransfer)) return false;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'copy';
                  return true;
                },
                drop(event, view) {
                  if (!enableDropInsertRef.current || !event.dataTransfer) return false;
                  if (!isRecognizedEditorDrop(event.dataTransfer)) return false;
                  event.preventDefault();
                  event.stopPropagation();
                  insertDroppedPayload(view, event.dataTransfer, event.clientX, event.clientY);
                  return true;
                },
                focus() {
                  if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
                  blurTimeoutRef.current = null;
                  return false;
                },
                blur(_event, view) {
                  if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
                  const caret = view.state.selection.main.head;
                  const line = view.state.doc.lineAt(caret);
                  const active = findHandlerEditorMention(
                    view.state.sliceDoc(line.from, caret),
                    line.from,
                    caret
                  );
                  blurTimeoutRef.current = setTimeout(() => {
                    blurTimeoutRef.current = null;
                    if (view.hasFocus) return;
                    dismissedMentionFromRef.current = active?.from ?? null;
                    setMentionState(null);
                  }, 120);
                  return false;
                },
              })
            ),
          ],
        }),
        parent,
      });
      viewRef.current = view;
      refreshMentionState(view);

      return () => {
        if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
        view.destroy();
        viewRef.current = null;
      };
      // Mount once. `value`/`readOnly` after the initial mount are synced by
      // the two effects below rather than listed here — see their comments.
      // (No react-hooks/exhaustive-deps in this repo's eslint config to
      // suppress — only @typescript-eslint rules are registered.)
    }, []);

    // External value sync — e.g. the fetched tool.ts arriving after mount
    // (edit mode), or a discard reverting to the loaded baseline. Only
    // dispatches when the incoming value actually differs from the live doc,
    // so this never fights the view's own onChange (which already reported
    // the same string upstream) or clobbers cursor position mid-typing.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }, [value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: readOnlyCompartmentRef.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
      if (readOnly) setMentionState(null);
    }, [readOnly]);

    // The `@` search is the single completion surface while its token is
    // active. Close CodeMirror's native autocomplete so it cannot render a
    // second, partially hidden options panel underneath the mention popover.
    useEffect(() => {
      if (mentionState && viewRef.current) closeCompletion(viewRef.current);
    }, [mentionState]);

    const handleMentionSelect = useCallback((hit: NodeMentionHit) => {
      const view = viewRef.current;
      if (!view) return;
      const caret = view.state.selection.main.head;
      const line = view.state.doc.lineAt(caret);
      const active = findHandlerEditorMention(
        view.state.sliceDoc(line.from, caret),
        line.from,
        caret
      );
      if (!active) return;
      dismissedMentionFromRef.current = null;
      const insert = quoteStringLiteral(mentionValue(hit));
      view.dispatch({
        changes: { from: active.from, to: active.to, insert },
        selection: { anchor: active.from + insert.length },
      });
      setMentionState(null);
      view.focus();
    }, []);

    // Click-to-insert handle for the chip palettes rendered above this editor
    // — see HandlerEditorHandle's doc comment. `[]` deps: the closure reads
    // `viewRef.current` fresh on every call, so it never goes stale.
    useImperativeHandle(
      ref,
      () => ({
        insertText: (text: string) => {
          const view = viewRef.current;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
          });
          view.focus();
        },
      }),
      []
    );

    const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
      if (!enableDropInsert) return;
      if (!isRecognizedEditorDrop(e.dataTransfer)) return;
      // Mechanism (1) in the component doc comment: claim the drop and keep
      // it from bubbling to the pane's own dragover handler.
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
      if (!enableDropInsert) return;
      if (!isRecognizedEditorDrop(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const view = viewRef.current;
      if (!view) return;
      insertDroppedPayload(view, e.dataTransfer, e.clientX, e.clientY);
    };

    return (
      <>
        <div
          ref={containerRef}
          className={`${styles.root} ${fillHeight ? styles.fillHeight : ''}`}
          data-testid="handler-editor"
          data-mention-open={mentionState ? 'true' : undefined}
          // Recognized by usePaneDropZone.isNestedChipDropTarget; mechanism
          // (2) in the component doc comment.
          data-pane-drop-target={enableDropInsert ? 'node-chip' : undefined}
          onDragOver={enableDropInsert ? handleDragOver : undefined}
          onDrop={enableDropInsert ? handleDrop : undefined}
        />
        {enableNodeMentions && mentionState && !readOnly ? (
          <NodeMentionSearch
            ref={mentionSearchRef}
            open
            query={mentionState.query}
            anchorRect={mentionState.anchor}
            triggerOptions={mentionTriggerOptions}
            workspaceOnly
            onSelect={handleMentionSelect}
            onClose={() => {
              dismissedMentionFromRef.current = mentionState.from;
              setMentionState(null);
            }}
          />
        ) : null}
      </>
    );
  }
);
