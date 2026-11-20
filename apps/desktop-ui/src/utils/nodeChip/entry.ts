import { CUSTOM_TABLE_ID_PATTERN } from '@snaglet/shared/types/tables';

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TABLE_SOURCE = CUSTOM_TABLE_ID_PATTERN.source.replace(/^\^|\$$/g, '');

export const ENTRY_HREF_SOURCE = `entry:${TABLE_SOURCE}/${UUID_SOURCE}(?![A-Za-z0-9_/-])`;
const ENTRY_ID_RE = new RegExp(`^(${TABLE_SOURCE})/(${UUID_SOURCE})$`);

interface EntryChipIdentity {
  tableId: string;
  entryId: string;
}

/** Entries belong to custom tables, and UUID case is not part of their identity. */
export function parseEntryChipId(id: string): EntryChipIdentity | null {
  const match = ENTRY_ID_RE.exec(id);
  return match ? { tableId: match[1], entryId: match[2].toLowerCase() } : null;
}
