import { Chip } from '@desktop/features/rich-markdown/renderer/Chip';

interface EntryReferenceChipProps {
  tableId: string;
  entryId: string;
  /** Authoritative page/search label; avoids an extra initial name lookup. */
  name?: string;
  /** False inside another interactive control, such as a cell edit button. */
  interactive?: boolean;
  /** False when a parent owns relation-list reorder drags. */
  draggable?: boolean;
}

export function EntryReferenceChip({
  tableId,
  entryId,
  name,
  interactive = true,
  draggable = true,
}: EntryReferenceChipProps) {
  const id = `${tableId}/${entryId.toLowerCase()}`;
  return (
    <Chip
      kind="entry"
      nodeId={id}
      href={`entry:${id}`}
      title={name ?? ''}
      knownEntryName={name}
      interactive={interactive}
      draggable={draggable}
      showIncludeToggle={false}
    />
  );
}
