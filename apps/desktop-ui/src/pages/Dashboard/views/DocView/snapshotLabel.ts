import { formatDateTime } from '@snaglet/shared/utils';
import type { DocSnapshotMeta } from '@desktop/utils/api/docs';

/**
 * The versions Snaglet makes itself, by the marker stored in their label or
 * reason: the Snapshot button ('manual'), the copy taken before a restore
 * ('pre-restore') and the one taken before an agent's edit ('pre-edit').
 */
const KIND_NAMES = new Map<string, string>([
  ['manual', 'Snapshot'],
  ['pre-restore', 'Before restore'],
  ['pre-edit', 'Before an agent edit'],
]);

/** What a version is: the name of a kind Snaglet makes, else the label someone gave it. */
function snapshotKind(snap: Pick<DocSnapshotMeta, 'label' | 'reason'>): string {
  const label = snap.label?.trim() || null;
  const labelKind = label ? KIND_NAMES.get(label) : undefined;
  if (labelKind) return labelKind;
  // A restore's own label names the version it replaced by id; the kind reads better.
  if (snap.reason === 'pre-restore') return 'Before restore';
  const reason = snap.reason?.trim() || null;
  return label ?? (reason ? (KIND_NAMES.get(reason) ?? reason) : 'Snapshot');
}

/** A version as the Versions list names it: "Snapshot · Nov 16, 2026 8:32 PM". */
export function snapshotLabel(
  snap: Pick<DocSnapshotMeta, 'label' | 'reason' | 'created_at'>
): string {
  return `${snapshotKind(snap)} · ${formatDateTime(snap.created_at)}`;
}
