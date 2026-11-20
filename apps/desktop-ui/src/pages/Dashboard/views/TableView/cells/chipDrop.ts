import { TABLE_RELATION_MAX_LINKS, type TableField } from '@snaglet/shared/types';
import { tableReferenceKindArticle, tableReferenceKindName } from '@snaglet/shared/utils';
import { snagletChipKindsFor } from '@desktop/features/table-entries/SnagletReferenceChip';
import { parseEntryChipId, type NodeChipData } from '@desktop/utils/nodeChip';

/** A drop's outcome: accepted, refused generically, or refused with a reason to show. */
export type ChipDropResult = boolean | string;

export const RELATION_LIMIT_PROBLEM = `Up to ${TABLE_RELATION_MAX_LINKS} entries can be linked. Remove one before adding another.`;

/**
 * The value a chip dropped on a relation adds: an entry of the related table,
 * or for a relation to Snaglet items an item of its kind (a project or container
 * chip for either containers kind). Null when the chip does not fit.
 */
export function relatedChipEntryId(
  field: TableField | undefined,
  chip: NodeChipData
): string | null {
  if (field?.type === 'relation' && field.referenceKind)
    return snagletChipKindsFor(field.referenceKind).includes(chip.kind) ? chip.id : null;
  if (field?.type !== 'relation' || chip.kind !== 'entry') return null;
  const identity = parseEntryChipId(chip.id);
  return identity?.tableId === field.referenceTableId ? identity.entryId : null;
}

/** One rejection vocabulary for open editors and unopened grid cells. */
export function chipDropProblem(field?: TableField, chip?: NodeChipData): string {
  if (!field || field.managed)
    return 'This field is read-only. Drop links into an editable Text field instead.';
  if (field.type === 'relation' && field.referenceKind)
    return `This field links to ${tableReferenceKindName(field.referenceKind, true)}. Drop ${tableReferenceKindArticle(field.referenceKind)} here.`;
  if (field.type === 'relation' && !field.referenceTableId)
    return 'Choose a table in field settings first.';
  if (field.type === 'relation')
    return chip?.kind === 'entry'
      ? 'This entry belongs to another table. Drop an entry from the related table here.'
      : 'Drop an entry from the related table here. Workspace and table links belong in a Text field.';
  if (field.type === 'select')
    return 'Choose an option for this Select cell. Drop links into a Text field instead.';
  const label =
    field.type === 'number'
      ? 'Number'
      : field.type === 'date'
        ? 'Date'
        : field.type === 'datetime'
          ? 'Date and time'
          : 'Checkbox';
  return `${label} cells can't hold links. Drop links into a Text field instead.`;
}
