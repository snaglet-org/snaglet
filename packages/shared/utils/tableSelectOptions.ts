import {
  TABLE_SELECT_MAX_OPTIONS,
  TABLE_SELECT_OPTION_COLORS,
  TABLE_SELECT_OPTION_ID_PATTERN,
  TABLE_SELECT_OPTION_LABEL_MAX_LENGTH,
  type TableSelectOption,
  type TableSelectOptionColor,
  type TableSelectOptionInput,
} from '../types/table-select-options';
import type { TableField, TableFieldDefinition } from '../types/table-fields';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const OPTION_KEYS = new Set(['id', 'label', 'color']);
/** Labels listed in a value error before it is cut short. */
const LISTED_LABELS = 30;

function isColor(value: unknown): value is TableSelectOptionColor {
  return TABLE_SELECT_OPTION_COLORS.some((color) => color === value);
}

/** A stored option label: trimmed, 1–100 characters, one line. */
export function selectOptionLabelProblem(label: unknown): string | null {
  if (typeof label !== 'string' || !label.trim()) return 'Option labels must be non-empty text.';
  if (label !== label.trim()) return 'Option labels cannot start or end with spaces.';
  if (label.length > TABLE_SELECT_OPTION_LABEL_MAX_LENGTH)
    return `Option labels can be at most ${TABLE_SELECT_OPTION_LABEL_MAX_LENGTH} characters.`;
  if (CONTROL_CHARACTERS.test(label))
    return 'Option labels cannot contain line breaks or control characters.';
  return null;
}

/** A request's option list: closed `{ id?, label, color? }` items, labels unique case-insensitively. */
export function selectOptionsProblem(options: unknown): string | null {
  if (!Array.isArray(options)) return 'Options must be a list.';
  if (options.length > TABLE_SELECT_MAX_OPTIONS)
    return `A select field can have at most ${TABLE_SELECT_MAX_OPTIONS} options.`;
  const labels = new Set<string>();
  const ids = new Set<string>();
  for (const option of options) {
    if (
      typeof option !== 'object' ||
      option === null ||
      Array.isArray(option) ||
      Object.keys(option).some((key) => !OPTION_KEYS.has(key))
    )
      return 'Each option must be { id?, label, color? }.';
    const { id, label, color } = option as Record<string, unknown>;
    const problem = selectOptionLabelProblem(label);
    if (problem) return problem;
    const key = String(label).toLowerCase();
    if (labels.has(key)) return `The option "${String(label)}" is listed twice.`;
    labels.add(key);
    if (id !== undefined) {
      if (typeof id !== 'string' || !TABLE_SELECT_OPTION_ID_PATTERN.test(id))
        return 'Option ids must look like opt-<lowercase letters, digits and dashes>.';
      if (ids.has(id)) return 'Each option id may appear only once.';
      ids.add(id);
    }
    if (color !== undefined && !isColor(color))
      return `Option colors are ${TABLE_SELECT_OPTION_COLORS.join(', ')}.`;
  }
  return null;
}

/**
 * A select definition's own rules. `multiple` left out may still mean a list
 * (an update keeps the current setting), so either default shape passes until
 * the model decides it; labels are checked only against options the request
 * carries, and again by the model against the options it resolves.
 */
export function selectDefinitionProblem(value: TableFieldDefinition): string | null {
  if (value.referenceTableId !== null) return 'Only relation fields can reference another table.';
  if (value.options !== undefined && value.options !== null) {
    const problem = selectOptionsProblem(value.options);
    if (problem) return problem;
  }
  const labels =
    value.options === undefined || value.options === null
      ? null
      : new Set(value.options.map((option) => option.label));
  const known = (label: string) => labels === null || labels.has(label);
  const fallback = value.defaultValue;
  if (fallback === null) return null;
  if (Array.isArray(fallback)) {
    if (value.multiple === false) return 'Choose one option, or none, for the default.';
    if (new Set(fallback).size !== fallback.length) return 'List each default option only once.';
    return fallback.every((label) => typeof label === 'string' && known(label))
      ? null
      : 'Choose default options from the field options.';
  }
  if (typeof fallback !== 'string') return 'Choose one of the options for the default.';
  if (value.multiple === true) return 'A multi-select default is a list of options.';
  return known(fallback) ? null : 'Choose one of the options for the default.';
}

/** The palette color used least by `taken`, earliest in the palette on ties. */
function leastUsedColor(taken: readonly TableSelectOptionColor[]): TableSelectOptionColor {
  let best: TableSelectOptionColor = TABLE_SELECT_OPTION_COLORS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of TABLE_SELECT_OPTION_COLORS) {
    const count = taken.filter((used) => used === color).length;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The stored options for a request's list: a known `id` keeps that option's
 * id (and its color unless one is given), anything else is a new option with
 * the given id or a minted one. Missing colors go to the least-used palette
 * color, in list order, so assignment is deterministic.
 */
export function resolveSelectOptions(
  current: readonly TableSelectOption[] | null,
  input: readonly TableSelectOptionInput[],
  mintId: () => string
): TableSelectOption[] {
  const existing = new Map((current ?? []).map((option) => [option.id, option]));
  const taken = new Set(input.flatMap((option) => (option.id ? [option.id] : [])));
  const drafts = input.map((option) => {
    let id = option.id;
    // A minted id must not collide with a listed or a removed option's id,
    // which would read as keeping (renaming) that option.
    while (id === undefined) {
      const minted = mintId();
      if (!taken.has(minted) && !existing.has(minted)) id = minted;
    }
    taken.add(id);
    return { id, label: option.label, color: option.color ?? existing.get(id)?.color };
  });
  const used = drafts.flatMap((option) => (option.color ? [option.color] : []));
  return drafts.map((option) => {
    if (option.color) return { id: option.id, label: option.label, color: option.color };
    const color = leastUsedColor(used);
    used.push(color);
    return { id: option.id, label: option.label, color };
  });
}

export interface SelectOptionChanges {
  /** Kept options whose label changed, old label → new label. */
  renames: Array<{ from: string; to: string }>;
  /** Labels of options that are gone. */
  removed: string[];
  /** Whether the set of allowed labels differs (the CHECK must be rebuilt). */
  labelsChanged: boolean;
}

/** What moving from `prev` to `next` does to stored values, matching options by id. */
export function selectOptionChanges(
  prev: readonly TableSelectOption[],
  next: readonly TableSelectOption[]
): SelectOptionChanges {
  const nextById = new Map(next.map((option) => [option.id, option]));
  const renames: SelectOptionChanges['renames'] = [];
  const removed: string[] = [];
  for (const option of prev) {
    const kept = nextById.get(option.id);
    if (!kept) removed.push(option.label);
    else if (kept.label !== option.label) renames.push({ from: option.label, to: kept.label });
  }
  const sorted = (options: readonly TableSelectOption[]) =>
    options
      .map((option) => option.label)
      .sort()
      .join('\u0000');
  return { renames, removed, labelsChanged: sorted(prev) !== sorted(next) };
}

function allowedLabels(field: Pick<TableField, 'name' | 'options'>): string {
  const labels = (field.options ?? []).map((option) => option.label);
  if (!labels.length) return `${field.name} has no options yet.`;
  const listed = labels.slice(0, LISTED_LABELS).join(', ');
  return `Options: ${listed}${labels.length > LISTED_LABELS ? `, … (${labels.length} in all)` : ''}.`;
}

/**
 * A select value: one option label, or for a multi-select a list of distinct
 * labels in the chosen order (null means `[]`). Null on a single select is the
 * caller's nullability rule.
 */
export function selectValueProblem(
  field: Pick<TableField, 'name' | 'options' | 'multiple'>,
  value: unknown
): string | null {
  const labels = new Set((field.options ?? []).map((option) => option.label));
  if (field.multiple) {
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
      return `${field.name} takes a list of options. ${allowedLabels(field)}`;
    if (new Set(value).size !== value.length) return 'Choose each option only once.';
    const unknown = value.find((item: string) => !labels.has(item));
    return unknown === undefined
      ? null
      : `"${unknown}" is not an option of ${field.name}. ${allowedLabels(field)}`;
  }
  if (typeof value !== 'string') return `${field.name} takes one option. ${allowedLabels(field)}`;
  return labels.has(value)
    ? null
    : `"${value}" is not an option of ${field.name}. ${allowedLabels(field)}`;
}
