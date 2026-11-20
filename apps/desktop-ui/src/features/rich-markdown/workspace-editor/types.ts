import type { DocLineLinkOptions } from '../lineLinks/useDocLineLinks';
import type { DocOutlineStore } from '../outline/docOutline';
/**
 * Props and ref handle for WorkspaceEditor, the chip-aware autosave editor
 * shared by workspace surfaces (task description, doc body, prompts). Loading a
 * value programmatically never fires a save. The chat composer is not a
 * consumer: it submits and clears instead of autosaving.
 */

import type { ReactNode } from 'react';

/**
 * Which surface the editor serves: picks mention scope, chip serialization,
 * default placeholder and aria-label. A new variant also needs a default-config
 * entry in `WorkspaceEditor.tsx`.
 */
export type WorkspaceEditorKind =
  | 'task-description'
  | 'doc-body'
  | 'thread-system-prompt'
  | 'agent-system-prompt'
  | 'agent-identity'
  | 'agent-thread-prompt'
  | 'project-description'
  | 'generic';

/**
 * Ref handle. `flush` skips the debounce and saves at once if the editor is
 * dirty (Cmd/Ctrl+S, or before navigating away).
 */
export interface WorkspaceEditorHandle {
  focus: () => void;
  /** Persist every queued edit and return the canonical saved value. */
  flush: () => Promise<string>;
}

export type WorkspaceEditorSaveResult = string | void;
export type WorkspaceEditorAutosaveState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'error';

export interface WorkspaceEditorProps {
  /** Doc bodies only: scroll to and highlight `focus`, and float a copy-link
   *  button over selections. */
  lineLinks?: DocLineLinkOptions;
  /** Doc bodies only: publish the doc's headings and the one in view to this outline. */
  outline?: DocOutlineStore;
  /**
   * The value persisted on the server (initial load, external edits, WS
   * patches). Updates never trigger autosave: a clean editor adopts the value
   * as its baseline, a dirty editor keeps the user's draft.
   */
  savedValue: string;

  /**
   * Persist a new value after a user edit and the debounce. Returning the
   * canonical string makes it the baseline at once; returning void waits for
   * the next `savedValue`.
   */
  onSave: (next: string) => Promise<WorkspaceEditorSaveResult> | WorkspaceEditorSaveResult;

  /** Selects mention scope, default placeholder, aria-label and chip flags. */
  kind: WorkspaceEditorKind;

  /**
   * `'autosave'` (default) saves on a debounce. `'manual'` saves only from the
   * Save button or Cmd/Ctrl+S, and a save never rewrites the draft. Fixed for
   * the editor's lifetime.
   */
  saveMode?: 'autosave' | 'manual';

  /**
   * Manual mode only: localStorage key that keeps the unsaved draft across
   * navigation and reloads. Build it with `draftStorageKey` from
   * `@desktop/features/composer`.
   */
  draftKey?: string;

  /** Debounce window in ms. Default 600. */
  autosaveDelayMs?: number;

  /** Initial mode. Read-first surfaces (doc body, task description) usually pass `'preview'`. */
  defaultMode?: 'edit' | 'preview';

  /** Override the default "show markdown/preview toggle" choice. */
  allowPreview?: boolean;

  /** Render the canonical markdown in a plain textarea instead of the rich editor. */
  sourceMode?: boolean;

  /** Override whether chips show the `↳` include toggle (system prompts, doc bodies). */
  allowInlineParse?: boolean;

  /** Serialize chips as bare ids (tool-parameter fields). */
  passIdOnly?: boolean;

  /** Override the default placeholder. */
  placeholder?: string;
  /** Override the default aria-label. */
  ariaLabel?: string;

  /** Multiline mode. Default true. */
  multiline?: boolean;

  /** Enable `@`-mention search. Default true. */
  enableNodeMentions?: boolean;

  /**
   * Use the always-editable WYSIWYG block editor (slash commands, list and
   * heading input rules, task lists) with no edit/preview split. Default on.
   */
  richBlocks?: boolean;

  /** Disable editing, e.g. while loading. The indicator row still renders. */
  disabled?: boolean;

  /**
   * Hide editor chrome (top-right slot, edit/preview toggle). Presentation
   * only: a controlled `sourceMode` still renders the source editor.
   */
  hideChrome?: boolean;

  /** Wrapper className passthrough. */
  className?: string;

  /** className for the editor body (textarea or TipTap contenteditable), for per-field sizing. */
  bodyClassName?: string;

  /**
   * Preview-mode checkbox toggles skip the debounce and call this with the
   * full updated markdown. The surface persists at once, then updates
   * `savedValue`.
   */
  onCheckboxAutoSave?: (updatedMarkdown: string) => void;

  /** Inline content in the mode-toggle row, left of the toggle (compact status pills). */
  topRightSlot?: ReactNode;

  /** Called whenever the autosave state changes, to show save status outside the editor. */
  onSaveStateChange?: (state: WorkspaceEditorAutosaveState, error: string | null) => void;
}
