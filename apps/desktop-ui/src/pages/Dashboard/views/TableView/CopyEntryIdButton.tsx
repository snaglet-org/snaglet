import { getErrorMessage } from '@snaglet/shared/utils';
import { CopyToClipboardButton } from '@desktop/components/CopyToClipboardButton';
import { showToast } from '@desktop/utils/toast';

/**
 * An icon button that copies an entry's id, on Board cards and in the entry
 * modal's header. Its click stays on the button, so a card neither opens nor
 * (being a button) starts a drag from it.
 */
export function CopyEntryIdButton({ entryId, className }: { entryId: string; className?: string }) {
  return (
    <CopyToClipboardButton
      value={entryId}
      className={className}
      stopPropagation
      idleTitle="Copy entry ID"
      copiedTitle="Entry ID copied!"
      aria-label="Copy entry ID"
      onCopySuccess={() => showToast('Entry ID copied')}
      onCopyError={(error) =>
        showToast(getErrorMessage(error, 'Could not copy the entry ID'), { durationMs: 4000 })
      }
    />
  );
}
