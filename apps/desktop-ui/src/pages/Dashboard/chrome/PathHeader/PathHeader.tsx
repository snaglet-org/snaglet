import { useId, useState, type FC, type ReactNode } from 'react';
import { CopyChipButton } from '@desktop/components';
import { CopyIcon } from '@desktop/components/Icons';
import { RenameInput } from '@desktop/features/workspace-tree/RenameInput';
import styles from './PathHeader.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

/**
 * A rename the caller owns end to end, for names with their own rules
 * (validation, conflicts). The caller opens and closes the session; the
 * header only swaps the title for the shared `RenameInput`.
 */
export interface PathHeaderRename {
  /** The caller's session is open: the title shows the field. */
  editing: boolean;
  /** Double-click on the title asks the caller to open a session. */
  begin: () => void;
  /**
   * Enter or blur. Resolving `false` keeps the field open with the typed
   * text (a refused name, a failed or conflicting save).
   */
  submit: (value: string) => Promise<boolean>;
  /** Escape. */
  cancel: () => void;
  /** Mirrors every keystroke, e.g. for live validation. */
  change?: (value: string) => void;
  /** Rewrites the text as the user types, e.g. `formatTableName`. */
  format?: (value: string) => string;
  /** A save is in flight: the field is read-only until it settles. */
  busy?: boolean;
  /** Quiet inline message beside the field while one applies. */
  error?: string | null;
}

export interface PathHeaderProps {
  id: string;
  title: string;
  ancestors: string[];
  icon?: ReactNode;
  /** Optional class hook for tinting/overriding the icon slot. */
  iconClassName?: string;
  /**
   * Optional rename handler. When provided, the title becomes
   * double-clickable: the user double-clicks to enter an inline input,
   * commits with Enter or blur, cancels with Escape. The handler is
   * called with the trimmed new title; throwing rolls the title back to
   * the previous value.
   *
   * When omitted, the title is plain text.
   */
  onRename?: (nextTitle: string) => Promise<void> | void;
  /**
   * Caller-owned rename session, for names that can be refused without
   * closing the field. Takes precedence over `onRename`.
   */
  rename?: PathHeaderRename;
  /**
   * Header layout. `'path'` (default) renders the full
   * `/ancestor/.../Title` breadcrumb with a leading slash + kind icon —
   * for workspace tree nodes (doc / thread / container). `'plain'` renders
   * just the title as text (no slash, no icon, no ancestor segments) — for
   * panes that aren't tree nodes (agents, settings, single tools).
   */
  variant?: 'path' | 'plain';
  /**
   * Whether to render the trailing "Copy ID" chip. Entity panes (agent /
   * doc / thread / container) expose it; settings-style panes hide it.
   * Defaults to `true`.
   */
  showCopyId?: boolean;
}

/**
 * Path-aware breadcrumb header — same vocabulary across doc / project /
 * thread surfaces: `/ancestor/.../Title` with an `id` copy chip.
 *
 * Pure presentational except for the optional rename affordance. Pass
 * `ancestors` from `useNodeAncestors` (or compute your own) — the
 * component doesn't fetch.
 */
export const PathHeader: FC<PathHeaderProps> = ({
  id,
  title,
  ancestors,
  icon,
  iconClassName,
  onRename,
  rename,
  variant = 'path',
  showCopyId = true,
}) => {
  // Keep the title in normal flow (no autofit). The pane chrome rail sizes
  // every control to its content (`.chrome > * { flex: 0 0 auto }` in
  // PaneChrome.module.scss), so this header is only as wide as its in-flow
  // children. `useAutofitText` with alignX/alignY makes the title
  // `position: absolute`, and a root-level node's header then collapses to
  // icon + slash + chip. Overlong names scroll with the chrome rail.
  const [editingTitle, setEditingTitle] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const errorId = useId();
  const renamable = Boolean(rename || onRename);
  const editing = rename ? rename.editing : editingTitle;
  const sessionError = rename?.error ?? null;

  const beginEdit = () => {
    if (rename) {
      rename.begin();
      return;
    }
    if (!onRename) return;
    setRenameError(null);
    setEditingTitle(true);
  };

  // `onRename` mode: an empty or unchanged title closes without a call; a
  // failed rename closes too, leaving the upstream title and the error in
  // the header tooltip.
  const commit = async (value: string): Promise<boolean> => {
    const next = value.trim();
    if (onRename && next.length > 0 && next !== title) {
      try {
        await onRename(next);
      } catch (err) {
        setRenameError(getErrorMessage(err, 'Rename failed'));
      }
    }
    setEditingTitle(false);
    return true;
  };

  // Plain panes (agents, settings, single tools) show just the name — no
  // ancestor segments, leading slash, or kind icon. Tree nodes keep the
  // full `/ancestor/.../Title` breadcrumb.
  const isPlain = variant === 'plain';
  const pathString = isPlain ? title : '/' + [...ancestors, title].join('/');
  const ancestorPath = isPlain ? '' : ancestors.join(' / ');
  const iconSlotClass = iconClassName ? `${styles.pathIcon} ${iconClassName}` : styles.pathIcon;

  return (
    <div className={styles.pathHeader} title={renameError ?? pathString}>
      {!isPlain && icon && (
        <span className={iconSlotClass} aria-hidden>
          {icon}
        </span>
      )}
      {!isPlain && (
        <span className={styles.pathLeader} aria-hidden>
          /
        </span>
      )}
      {/* The ancestors share one span that truncates (with an ellipsis)
          before the title gives up any room, so in a narrow pane the path
          collapses to "…" and the name stays readable. The header tooltip
          keeps the full path. */}
      {ancestorPath && (
        <>
          <span className={styles.pathAncestors}>{ancestorPath}</span>
          <span className={`${styles.pathSep} ${styles.pathAncestorsSep}`} aria-hidden>
            /
          </span>
        </>
      )}
      {editing ? (
        <>
          <RenameInput
            className={styles.pathTitleInput}
            initialValue={title}
            onCommit={rename ? rename.submit : commit}
            onCancel={rename ? rename.cancel : () => setEditingTitle(false)}
            onValueChange={rename?.change}
            format={rename?.format}
            busy={rename?.busy}
            errorId={sessionError ? errorId : undefined}
          />
          {sessionError && (
            <span id={errorId} className={styles.renameError} role="alert">
              {sessionError}
            </span>
          )}
        </>
      ) : (
        // Only the title is renameable: ancestors are containers this
        // surface doesn't own.
        <span className={styles.pathTitleBox}>
          <span
            className={styles.pathTitle}
            onDoubleClick={renamable ? beginEdit : undefined}
            title={renamable ? 'Double-click to rename' : undefined}
          >
            {title}
          </span>
        </span>
      )}
      {showCopyId && (
        <span className={styles.pathActions}>
          <CopyChipButton
            label="id"
            value={id}
            idleTitle="Copy ID"
            copiedTitle="ID copied!"
            icon={<CopyIcon />}
          />
        </span>
      )}
    </div>
  );
};
