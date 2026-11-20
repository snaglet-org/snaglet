/**
 * Search by meaning for a custom table's rows
 * (`/api/tables/:id/semantic-search`): on by default for tables up to the row
 * cap, off for bigger ones until a person turns it on. See docs/architecture.md.
 */

/** What an index of this many rows takes on disk. */
export interface SemanticSizeEstimate {
  rows: number;
  bytes: number;
  /** "~N MB" for a person to read; "~N KB" under a megabyte. */
  label: string;
}

export interface SemanticStatus {
  tableId: string;
  tableName: string;
  enabled: boolean;
  /** Rows in the table (counted up to a ceiling); `rowsCapped` past it. */
  rows: number;
  rowsCapped: boolean;
  /** Most rows that can be turned on without `confirm`. */
  rowCap: number;
  /** True when turning it on needs `confirm: true` (more rows than the cap). */
  needsConfirmation: boolean;
  /** Rows that have a vector now. */
  indexed: number;
  /** `off`, `indexing` (building; search uses what is built) or `ready` (a full pass found nothing to do). */
  state: 'off' | 'indexing' | 'ready';
  /**
   * On, but grown past the row cap without a confirmation: what is built
   * stays, nothing more is built until `confirm: true` (`paused` says so).
   */
  awaitingConfirm?: boolean;
  /** Why building is not moving, when it is not. */
  paused?: string;
  /** What the index takes (or will take) on disk. */
  estimate: SemanticSizeEstimate;
  /** The fields a row's card is made of: these cells are what gets embedded. */
  cardFields: string[];
  /** Fields left out because their name looks like a secret. */
  excludedByName: string[];
  /** Always present: leaving fields out by name is best-effort. */
  warning: string;
}

export interface UpdateSemanticSearchRequest {
  enabled: boolean;
  /** Needed to turn it on for a table over the row cap. */
  confirm?: boolean;
}

/** One active custom table in `GET /api/tables/semantic-search`, for the embeddings pane. */
export interface SemanticTableRow {
  tableId: string;
  tableName: string;
  /** The table's project, when it has one. */
  projectName: string | null;
  enabled: boolean;
  rows: number;
  rowsCapped: boolean;
  /** True when turning it on needs `confirm: true` (more rows than the cap). */
  needsConfirmation: boolean;
  /** Rows that have a vector now (0 while off). */
  indexed: number;
  state: 'off' | 'indexing' | 'ready';
  /** On, but past the row cap without a confirmation (see `SemanticStatus.awaitingConfirm`). */
  awaitingConfirm?: boolean;
  /** Why building is not moving, for a table that has it on. */
  paused?: string;
  estimate: SemanticSizeEstimate;
}

export interface SemanticOverviewResponse {
  tables: SemanticTableRow[];
}
