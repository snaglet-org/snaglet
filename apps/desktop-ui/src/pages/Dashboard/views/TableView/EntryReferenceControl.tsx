import { useState } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { CopyToClipboardButton } from '@desktop/components/CopyToClipboardButton';
import {
  clearChipDragPayload,
  nodeToChipMarkdown,
  setChipDragPayload,
  type NodeChipData,
} from '@desktop/utils/nodeChip';
import styles from './TableEntries.module.scss';

/**
 * A quiet, keyboard-reachable copy handle that also serves as the row's drag
 * source. It lives in the Name cell, or beside the row checkbox (`row`) while
 * the Name column is collapsed. The copied chip keeps an unnamed entry's
 * label empty; `label` (such as "Untitled 3") is only for display.
 */
export function EntryReferenceControl({
  tableId,
  entryId,
  name,
  label,
  placement = 'name',
}: {
  tableId: string;
  entryId: string;
  name: string;
  label: string;
  placement?: 'name' | 'row';
}) {
  const [error, setError] = useState<string | null>(null);
  const chip: NodeChipData = { kind: 'entry', id: `${tableId}/${entryId}`, title: name };
  const row = placement === 'row';
  return (
    <>
      <CopyToClipboardButton
        className={`${styles.referenceControl} ${row ? styles.rowReference : ''}`}
        aria-label={`Copy reference to ${label}`}
        idleTitle="Copy reference · drag to link"
        value={nodeToChipMarkdown(chip)}
        draggable
        onDragStart={(event) => setChipDragPayload(event, { chip, dragLabel: label })}
        onDragEnd={clearChipDragPayload}
        onCopySuccess={() => setError(null)}
        onCopyError={(err) => setError(getErrorMessage(err, 'Could not copy this reference'))}
      />
      {error && (
        <span
          className={`${styles.referenceError} ${row ? styles.rowReferenceError : ''}`}
          role="alert"
        >
          {error}
        </span>
      )}
    </>
  );
}
