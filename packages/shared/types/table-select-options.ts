/**
 * Calm tag colors a select option can use, in auto-assignment order. The UI
 * maps each name to its own theme tokens; the server stores only the name.
 */
export const TABLE_SELECT_OPTION_COLORS = [
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
  'pink',
  'brown',
  'gray',
] as const;
export type TableSelectOptionColor = (typeof TABLE_SELECT_OPTION_COLORS)[number];

/** Most options one select field may have (also the cap for text → select conversions). */
export const TABLE_SELECT_MAX_OPTIONS = 100;
export const TABLE_SELECT_OPTION_LABEL_MAX_LENGTH = 100;
/** Stable option ids: server-minted `generateId('opt')` values, or client-minted in that form. */
export const TABLE_SELECT_OPTION_ID_PATTERN = /^opt-[a-z0-9-]{1,43}$/;

/**
 * One preset value of a select field. `id` is stable across renames, `label`
 * is the stored cell value (unique per field, case-insensitively).
 */
export interface TableSelectOption {
  id: string;
  label: string;
  color: TableSelectOptionColor;
}

/**
 * An option in a create/update request, in display order. An `id` of an
 * existing option keeps it (a different `label` renames it and every value
 * holding it); an unknown or missing `id` adds an option. Existing options left
 * out are removed and cleared from entries. A missing color is assigned.
 */
export interface TableSelectOptionInput {
  id?: string;
  label: string;
  color?: TableSelectOptionColor;
}

/** `GET /api/tables/:id/fields/:fieldId/options/usage`: entries holding each option, by option id. */
export interface TableSelectOptionUsageResponse {
  usage: Record<string, number>;
}
