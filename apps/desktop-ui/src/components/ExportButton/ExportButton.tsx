import { useEffect, type FC } from 'react';
import { Button } from '@desktop/components';
import { ExportIcon } from '@desktop/components/Icons';
import { useNodeExport, type ExportInput } from '@desktop/hooks/useNodeExport';
import styles from './ExportButton.module.scss';

type ExportButtonProps = ExportInput & {
  /** Compact form for a pane topbar; the default suits a settings row. */
  variant?: 'topbar' | 'inline';
  label?: string;
  disabled?: boolean;
};

/**
 * "Export" — one button, used from the pane topbar (icon only, the same glyph
 * as the workspace-tree row action) and from agent settings (text).
 *
 * It reports what actually happened rather than a generic success. Three of
 * the outcomes are easy to get wrong and each is called out below:
 *
 *  - a **renamed** file (a collision produced " (2)") must not be reported as
 *    the name the user typed, or they will go looking for the wrong file;
 *  - **canceling** the save dialog is a decision, not a failure, so it gets a
 *    neutral note instead of a red error;
 *  - a **browser download** never has a path, so it must not claim one.
 */
export const ExportButton: FC<ExportButtonProps> = ({
  variant = 'inline',
  label = 'Export',
  disabled,
  ...input
}) => {
  const { state, exportNode, reset } = useNodeExport();

  // A previous outcome should not sit next to a new target. Reset when the
  // thing being exported changes.
  useEffect(() => reset(), [input.kind, input.id, reset]);

  const busy = state.status === 'working';
  // The topbar shows the same export glyph as the workspace-tree rows; the
  // word lives on as the accessible name and tooltip.
  const iconOnly = variant === 'topbar';

  return (
    <div className={variant === 'topbar' ? styles.topbar : styles.inline}>
      <Button
        variant={variant === 'topbar' ? 'ghost' : 'neutral'}
        size={variant === 'topbar' ? 'sm' : 'md'}
        onClick={() => void exportNode(input)}
        disabled={disabled || busy}
        loading={busy}
        // Icon-only keeps its square while busy: spinner only, no text.
        loadingText={iconOnly ? '' : 'Exporting…'}
        iconOnly={iconOnly}
        aria-label={iconOnly ? label : undefined}
        title={
          iconOnly
            ? `${label} — save this to a folder on your computer`
            : 'Save this to a folder on your computer'
        }
      >
        {iconOnly ? <ExportIcon size={14} /> : label}
      </Button>

      {state.status === 'written' && (
        <span className={styles.result} role="status">
          {state.renamed ? (
            <>
              Saved as <strong>{state.fileName}</strong> — a file with the name you chose already
              existed, so it was not replaced.
            </>
          ) : (
            <>
              Saved to <span className={styles.path}>{state.path}</span>
            </>
          )}
        </span>
      )}

      {state.status === 'downloaded' && (
        <span className={styles.result} role="status">
          Downloaded <strong>{state.fileName}</strong>.
        </span>
      )}

      {/* Neutral, not an error: the user closed the dialog on purpose. */}
      {state.status === 'canceled' && (
        <span className={styles.muted} role="status">
          Export canceled.
        </span>
      )}

      {state.status === 'error' && (
        <span className={styles.error} role="alert">
          {state.message}
        </span>
      )}
    </div>
  );
};
