/** Search tiers supported by the global palette search API. */
export const PALETTE_SEARCH_MODES = ['keyword', 'hybrid', 'semantic'] as const;

export type PaletteSearchMode = (typeof PALETTE_SEARCH_MODES)[number];

/** Rows the short Entries section of an unfiltered quick search lists at most. */
export const PALETTE_ENTRY_SECTION_LIMIT = 5;

/** Rows an `entry:` quick search lists at most. */
export const PALETTE_ENTRY_FILTER_LIMIT = 20;

/**
 * Matches found only by meaning (no keyword hit) an unfiltered quick search
 * lists: the closest this many across workspace items and indexed files
 * together. Keyword matches are listed apart from this budget.
 */
export const PALETTE_MEANING_MATCH_LIMIT = 5;

/**
 * An entry hit scoring at least this is a strong match: its Name is the query
 * (1) or starts with it (0.9). An unfiltered quick search lists strong matches
 * near the top instead of in the Entries section after every other kind.
 */
export const PALETTE_ENTRY_STRONG_MATCH_SCORE = 0.9;

/**
 * A table row ("entry") found by quick search: `entry: <keywords>`,
 * `table:<name> entry: <keywords>`, or the short Entries section of an
 * unfiltered search. Ids are the table's catalog id and the entry's UUID.
 */
export interface PaletteEntryHit {
  tableId: string;
  /** The table's display name. */
  tableName: string;
  /** The table's project home; null for a workspace-wide table. */
  projectId: string | null;
  entryId: string;
  /** The entry's Name ('' when it has none). */
  name: string;
  /**
   * Relevance in [0, 1], best first; 0 for every row of a browse. Name matches
   * score 1 (the whole Name), 0.9 (its start), 0.8 (inside it), 0.7 (every
   * word in it), else 0.2–0.7; see {@link PALETTE_ENTRY_STRONG_MATCH_SCORE}.
   */
  score: number;
  /** When the entry was created (UTC ISO instant). */
  createdAt: string;
}
