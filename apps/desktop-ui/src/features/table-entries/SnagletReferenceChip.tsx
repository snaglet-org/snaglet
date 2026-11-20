import {
  type RelatedTableItems,
  type TableReferenceItem,
  type TableReferenceKind,
} from '@snaglet/shared/types';
import { tableReferenceKindName } from '@snaglet/shared/utils';
import { Chip } from '@desktop/features/rich-markdown/renderer/Chip';
import { chipHrefForNode, type ChipKind } from '@desktop/utils/nodeChip';
import { knownItem } from './snagletItemTitles';

/** What a purged item's chip reads as. */
const UNAVAILABLE_ITEM_LABEL = 'Unavailable';

/**
 * The chip kind an item of `kind` renders and drags as. A project is a
 * container (category `project`), so it opens and drops as a container.
 */
function snagletChipKind(kind: TableReferenceKind): ChipKind {
  return kind === 'project' ? 'container' : kind;
}

/** The chip kinds a relation to `kind` accepts when one is dropped on it. */
export function snagletChipKindsFor(kind: TableReferenceKind): readonly ChipKind[] {
  return kind === 'project' || kind === 'container' ? ['container', 'project'] : [kind];
}

interface SnagletReferenceChipProps {
  kind: TableReferenceKind;
  id: string;
  /** The page's `relatedItems`; the session's remembered titles fill gaps. */
  relatedItems?: RelatedTableItems;
  /** An item already resolved by the caller (a search result). */
  item?: TableReferenceItem;
  /** False inside another interactive control, such as a picker's chip button. */
  interactive?: boolean;
  /** False when a parent owns relation-list reorder drags. */
  draggable?: boolean;
}

/**
 * A relation value that links to a Snaglet item: the item's chip with its title.
 * An archived item is muted and says so; a purged one reads "Unavailable"
 * and opens nothing. A click opens it through the usual chip navigation.
 */
export function SnagletReferenceChip({
  kind,
  id,
  relatedItems,
  item,
  interactive = true,
  draggable = true,
}: SnagletReferenceChipProps) {
  const resolved = item ?? knownItem(kind, id, relatedItems);
  const chipKind = snagletChipKind(kind);
  const title = resolved?.title ?? UNAVAILABLE_ITEM_LABEL;
  return (
    <Chip
      kind={chipKind}
      nodeId={id}
      href={chipHrefForNode({ kind: chipKind, id, title })}
      title={title}
      interactive={interactive}
      draggable={draggable}
      showIncludeToggle={false}
      availability={!resolved ? 'unavailable' : resolved.archived ? 'archived' : undefined}
      itemNoun={tableReferenceKindName(kind)}
    />
  );
}
