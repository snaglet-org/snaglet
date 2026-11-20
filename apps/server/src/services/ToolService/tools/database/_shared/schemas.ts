/** Every table tool addresses its table by name (a catalog id also works). */
export const tableParam = { type: 'string' } as const;

/** SQL-mode bounds; the same limits TableQuery enforces. */
export const SQL_LIMIT = { min: 1, max: 200, default: 50 } as const;
export const SQL_MAX_CELL = { min: 40, max: 4000, default: 200 } as const;
/** Most ids one `{table, ids}` read takes; the same bound as AGENT_READ_MAX_IDS. */
export const READ_MAX_IDS = 50;
/** Rows per page of a structured `{table, where|sort|columns|page}` read; mirrors listAgentEntries. */
export const AGENT_LIST_LIMIT = { max: 100, default: 25 } as const;
