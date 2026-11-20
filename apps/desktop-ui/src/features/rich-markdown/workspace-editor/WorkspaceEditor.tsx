import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import type { Editor } from '@tiptap/core';
import { DocumentFind } from '@desktop/features/pane-find/DocumentFind';
import { useDocLineLinks } from '../lineLinks/useDocLineLinks';
import { HostDocProvider } from '../lineLinks/hostDoc';
import { useDocOutlineSync } from '../outline/useDocOutlineSync';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { useHorizontalWheelScroll } from '@desktop/hooks/useHorizontalWheelScroll';

import { Button } from '@desktop/components/controls/Button/Button';

import { SourceMarkdownArea } from './SourceMarkdownArea';
import { useModeSwitchPlace } from './useModeSwitchPlace';
import { useWorkspaceEditorAutosave } from './useWorkspaceEditorAutosave';
import { useWorkspaceEditorManualSave } from './useWorkspaceEditorManualSave';
import type {
  WorkspaceEditorAutosaveState,
  WorkspaceEditorHandle,
  WorkspaceEditorKind,
  WorkspaceEditorProps,
} from './types';
import styles from './WorkspaceEditor.module.scss';

interface KindDefaults {
  placeholder: string;
  ariaLabel: string;
  allowInlineParse: boolean;
  defaultMode: 'edit' | 'preview';
}

// Per-kind defaults, so most surfaces need nothing beyond `kind`. Props
// override any of them. Defaults shared by every kind live on the props
// destructuring below.
const KIND_DEFAULTS: Record<WorkspaceEditorKind, KindDefaults> = {
  'task-description': {
    placeholder: 'Add a description…',
    ariaLabel: 'Task description',
    allowInlineParse: true,
    defaultMode: 'preview',
  },
  'doc-body': {
    placeholder: 'Write the doc…',
    ariaLabel: 'Doc body',
    allowInlineParse: true,
    defaultMode: 'preview',
  },
  'thread-system-prompt': {
    placeholder: 'System prompt for this thread… drop a sidebar item to inline its content.',
    ariaLabel: 'Thread system prompt',
    allowInlineParse: true,
    defaultMode: 'edit',
  },
  'agent-system-prompt': {
    placeholder: 'Describe how this agent should behave.',
    ariaLabel: 'Agent system prompt',
    allowInlineParse: true,
    defaultMode: 'edit',
  },
  'agent-identity': {
    placeholder: 'Describe who this agent is.',
    ariaLabel: 'Agent identity',
    allowInlineParse: true,
    defaultMode: 'edit',
  },
  'agent-thread-prompt': {
    placeholder: "Add to this agent's system prompt for this thread only.",
    ariaLabel: 'Agent thread instructions',
    allowInlineParse: true,
    defaultMode: 'edit',
  },
  'project-description': {
    placeholder: 'Project description — what is this project? Drop a doc to show its content here.',
    ariaLabel: 'Project description',
    // The description is spliced into every in-project agent's context, so
    // it must support `![](doc-…)` transclusion chips.
    allowInlineParse: true,
    defaultMode: 'edit',
  },
  generic: {
    placeholder: '',
    ariaLabel: 'Editor',
    allowInlineParse: false,
    defaultMode: 'edit',
  },
};

const INTERACTIVE_FOCUS_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[contenteditable="true"]',
  '.md-chip',
  '.md-chip-toggle',
].join(',');

/**
 * The shared chip-aware editor for workspace surfaces, with autosave or
 * explicit Save. See `types.ts` for the prop and handle contract.
 */
export const WorkspaceEditor = forwardRef<WorkspaceEditorHandle, WorkspaceEditorProps>(
  function WorkspaceEditor(props, ref) {
    // The engine is fixed for the editor's lifetime: two components, so no
    // hook is ever called conditionally.
    return props.saveMode === 'manual' ? (
      <ManualSaveWorkspaceEditor {...props} ref={ref} />
    ) : (
      <AutosaveWorkspaceEditor {...props} ref={ref} />
    );
  }
);

/** The draft engine a body renders against: autosave or explicit Save. */
interface EditorEngine {
  value: string;
  state: WorkspaceEditorAutosaveState;
  error: string | null;
  onChange: (next: string) => void;
  flush: () => Promise<string>;
}

const AutosaveWorkspaceEditor = forwardRef<WorkspaceEditorHandle, WorkspaceEditorProps>(
  function AutosaveWorkspaceEditor(props, ref) {
    const autosave = useWorkspaceEditorAutosave({
      savedValue: props.savedValue,
      onSave: props.onSave,
      delayMs: props.autosaveDelayMs,
    });
    return <WorkspaceEditorBody {...props} engine={autosave} ref={ref} />;
  }
);

/**
 * Explicit-Save variant: nothing is sent while typing. A Save button under
 * the editor (enabled only while the draft differs from the saved value)
 * sends it, alongside Cmd/Ctrl+S. Discard brings the saved value back.
 */
const ManualSaveWorkspaceEditor = forwardRef<WorkspaceEditorHandle, WorkspaceEditorProps>(
  function ManualSaveWorkspaceEditor(props, ref) {
    const manual = useWorkspaceEditorManualSave({
      savedValue: props.savedValue,
      onSave: props.onSave,
      draftKey: props.draftKey,
    });
    const { flush, discard, dirty, state, error } = manual;
    const save = useCallback(() => {
      void flush().catch((err: unknown) => {
        // Shown in the bar below; logged for the console trail only.
        console.error('WorkspaceEditor: save failed', err);
      });
    }, [flush]);
    const saving = state === 'saving';
    const footer = (
      <div className={styles.saveBar} data-testid="workspace-editor-save-bar">
        <span
          className={styles.saveStatus}
          data-state={state}
          role="status"
          aria-live="polite"
          title={state === 'error' ? (error ?? undefined) : undefined}
        >
          {state === 'saving'
            ? 'Saving…'
            : state === 'error'
              ? `Save failed${error ? `: ${error}` : ''} — your text is kept`
              : state === 'dirty'
                ? 'Unsaved changes'
                : state === 'saved'
                  ? 'Saved'
                  : ''}
        </span>
        {dirty && !saving && (
          <Button size="xs" variant="ghost" onClick={discard} disabled={props.disabled}>
            Discard
          </Button>
        )}
        <Button
          size="xs"
          variant="primary"
          onClick={save}
          disabled={!dirty || saving || props.disabled}
          loading={saving}
          loadingText="Saving…"
          title="Save (⌘S)"
        >
          Save
        </Button>
      </div>
    );
    return <WorkspaceEditorBody {...props} engine={manual} footer={footer} ref={ref} />;
  }
);

const WorkspaceEditorBody = forwardRef<
  WorkspaceEditorHandle,
  WorkspaceEditorProps & { engine: EditorEngine; footer?: ReactNode }
>(function WorkspaceEditorBody(props, ref) {
  const { engine: autosave, footer } = props;
  const defaults = KIND_DEFAULTS[props.kind];
  const [findEditor, setFindEditor] = useState<Editor | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const {
    defaultMode = defaults.defaultMode,
    allowPreview = true,
    allowInlineParse = defaults.allowInlineParse,
    passIdOnly = false,
    richBlocks = true,
    sourceMode = false,
    placeholder = defaults.placeholder,
    ariaLabel = defaults.ariaLabel,
    multiline = true,
    enableNodeMentions = true,
    disabled = false,
    hideChrome = false,
    className,
    bodyClassName,
    onCheckboxAutoSave,
    topRightSlot,
    onSaveStateChange,
  } = props;
  const visibleTopRightSlot = hideChrome ? null : topRightSlot;
  const hostDocId = props.kind === 'doc-body' ? (props.lineLinks?.docId ?? null) : null;
  // Switching between the rendered and markdown views keeps the caret,
  // selection and scroll place.
  useModeSwitchPlace(sourceMode, findEditor, sourceRef, autosave.value);
  const lineLinkButton = useDocLineLinks(
    findEditor,
    autosave.value,
    sourceMode,
    sourceRef,
    props.kind === 'doc-body' ? props.lineLinks : undefined
  );
  useDocOutlineSync(
    findEditor,
    autosave.value,
    sourceMode,
    sourceRef,
    props.kind === 'doc-body' ? props.outline : undefined
  );

  // Explicit user flushes share autosave's visible error state. Consume the
  // rejection here so keyboard/submit fire-and-forget paths never emit an
  // unhandled promise rejection.
  const flushSafely = useCallback(() => {
    void autosave.flush().catch((err: unknown) => {
      // Already surfaced through autosave's visible error state; log for
      // the console trail only.
      console.error('WorkspaceEditor: flush failed', err);
    });
  }, [autosave.flush]);

  // Save status shows outside the editor: consumers pipe it to their section
  // title via `onSaveStateChange` and EditorSaveHint.
  useEffect(() => {
    onSaveStateChange?.(autosave.state, autosave.error);
  }, [autosave.error, autosave.state, onSaveStateChange]);

  // Focus the editor surface via the underlying DOM — neither
  // ChipEditableInput nor the source textarea exposes a ref, but each is
  // the only focusable body element inside our wrapper at a time.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const focusEditable = useCallback(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
    if (!el) return false;
    el.focus();
    return true;
  }, []);

  // Cmd/Ctrl+S — flush the debounce immediately, so prompt surfaces can save
  // without waiting for the debounce window.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushSafely();
      }
    },
    [flushSafely]
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: focusEditable,
      flush: autosave.flush,
    }),
    [autosave.flush, focusEditable]
  );

  const handleBodyMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      const target = e.target as HTMLElement | null;
      // A press React bubbled up from a dialog opened in the body (a table's
      // large view) is not a press on the body.
      if (!target || !e.currentTarget.contains(target)) return;
      if (target.closest(INTERACTIVE_FOCUS_SELECTOR)) return;
      if (!wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')) return;
      e.preventDefault();
      focusEditable();
    },
    [disabled, focusEditable]
  );

  // Delegated wheel handling for the editor body, where the chip/mode rail
  // and ProseMirror's `.tableWrapper` overflow sideways: each gesture keeps
  // to one axis, so scrolling down over a table moves the doc only, and the
  // rail, a strip with no vertical scrolling around it, takes a vertical
  // wheel sideways.
  // The preview's markdown is already covered by MarkdownRenderer's own
  // listener, which marks the event handled so this one does not scroll the
  // same region twice.
  const bodyWheelRef = useHorizontalWheelScroll<HTMLDivElement>();

  const handleSourceChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      autosave.onChange(e.target.value);
    },
    [autosave.onChange]
  );

  return (
    <div
      ref={wrapRef}
      className={[styles.wrap, className].filter(Boolean).join(' ')}
      onKeyDown={handleKeyDown}
    >
      {props.kind === 'doc-body' && (
        <DocumentFind
          editor={findEditor}
          source={sourceMode}
          value={autosave.value}
          onChange={autosave.onChange}
          sourceRef={sourceRef}
          disabled={disabled}
        />
      )}
      <div ref={bodyWheelRef} className={styles.body} onMouseDown={handleBodyMouseDown}>
        {sourceMode ? (
          // Raw markdown editor on the same draft as the rich editor, so
          // toggling does not round-trip the text; only the next rich edit
          // re-serializes it.
          <div className={styles.sourceHost}>
            {visibleTopRightSlot ? (
              <div className={styles.modeRow}>{visibleTopRightSlot}</div>
            ) : null}
            <SourceMarkdownArea
              ref={sourceRef}
              // Not `bodyClassName`: that styles the rendered editor. The
              // raw view is monospace over the shared `.body` well, with
              // live heading, list, quote and inline styling.
              value={autosave.value}
              onChange={handleSourceChange}
              placeholder={placeholder}
              disabled={disabled}
              spellCheck={false}
              aria-label={`${ariaLabel} (markdown source)`}
              data-testid="workspace-editor-source-textarea"
            />
          </div>
        ) : (
          // A doc body tells its chips which doc they sit in, so an anchored
          // chip into this same doc scrolls in place instead of opening it.
          <HostDocProvider docId={hostDocId}>
            <ChipEditableInput
              onEditorReady={props.kind === 'doc-body' ? setFindEditor : undefined}
              value={autosave.value}
              onChange={autosave.onChange}
              placeholder={placeholder}
              multiline={multiline}
              disabled={disabled}
              className={bodyClassName}
              ariaLabel={ariaLabel}
              allowInlineParse={allowInlineParse}
              allowMarkdownPreview={!hideChrome && allowPreview}
              defaultMode={defaultMode}
              passIdOnly={passIdOnly}
              richBlocks={richBlocks}
              enableNodeMentions={enableNodeMentions}
              onSubmit={flushSafely}
              onCheckboxAutoSave={onCheckboxAutoSave}
              topRightSlot={visibleTopRightSlot}
              // `value` changes from outside only when `savedValue` moves
              // under a clean draft: someone else saved.
              keepSelectionOnExternalChange
            />
          </HostDocProvider>
        )}
      </div>
      {footer}
      {lineLinkButton}
    </div>
  );
});
