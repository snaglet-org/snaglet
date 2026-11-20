import type { TableFieldDefault, TableSelectOptionInput } from '@snaglet/shared/types';
import { generateId, resolveSelectOptions, selectOptionsProblem } from '@snaglet/shared/utils';

export interface SelectOptionsValue {
  options: TableSelectOptionInput[];
  defaultValue: TableFieldDefault;
}

/** Validate a committed label against the whole list, including case-insensitive uniqueness. */
export function selectOptionEditProblem(
  options: readonly TableSelectOptionInput[],
  label: string,
  index?: number
): string | null {
  const next = [...options];
  if (index === undefined) next.push({ label });
  else if (next[index]) next[index] = { ...next[index], label };
  return selectOptionsProblem(next);
}

export function addSelectOption(value: SelectOptionsValue, label: string): SelectOptionsValue {
  return {
    ...value,
    options: resolveSelectOptions(null, [...value.options, { label }], () => generateId('opt')),
  };
}

/** Labels, not ids, are the stored defaults, so a rename must update both in one patch. */
export function renameSelectOption(
  value: SelectOptionsValue,
  index: number,
  label: string
): SelectOptionsValue {
  const option = value.options[index];
  if (!option || option.label === label) return value;
  const replace = (selected: string) => (selected === option.label ? label : selected);
  return {
    options: value.options.map((item, position) =>
      position === index ? { ...item, label } : item
    ),
    defaultValue: Array.isArray(value.defaultValue)
      ? value.defaultValue.map(replace)
      : typeof value.defaultValue === 'string'
        ? replace(value.defaultValue)
        : value.defaultValue,
  };
}

export function removeSelectOption(value: SelectOptionsValue, index: number): SelectOptionsValue {
  const option = value.options[index];
  if (!option) return value;
  return {
    options: value.options.filter((_item, position) => position !== index),
    defaultValue: Array.isArray(value.defaultValue)
      ? value.defaultValue.filter((label) => label !== option.label)
      : value.defaultValue === option.label
        ? null
        : value.defaultValue,
  };
}

export function moveSelectOption(
  value: SelectOptionsValue,
  from: number,
  to: number
): SelectOptionsValue {
  const option = value.options[from];
  if (!option || from === to || to < 0 || to >= value.options.length) return value;
  const options = [...value.options];
  options.splice(from, 1);
  options.splice(to, 0, option);
  return { ...value, options };
}

function sameDefault(left: TableFieldDefault, right: TableFieldDefault): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((label, index) => label === right[index])
    : left === right;
}

function mapDefault(
  value: TableFieldDefault,
  labels: Map<string, string | null>
): TableFieldDefault {
  const replace = (label: string) => (labels.has(label) ? (labels.get(label) ?? null) : label);
  return Array.isArray(value)
    ? value.flatMap((label) => {
        const next = replace(label);
        return next === null ? [] : [next];
      })
    : typeof value === 'string'
      ? replace(value)
      : value;
}

/** Adopt assigned metadata without overwriting edits queued behind the saved definition. */
export function reconcileSelectOptions(
  sent: SelectOptionsValue,
  current: SelectOptionsValue,
  saved: SelectOptionsValue
): SelectOptionsValue {
  const matches = (option: TableSelectOptionInput, candidate: TableSelectOptionInput) =>
    option.id ? option.id === candidate.id : option.label === candidate.label;
  const serverFor = (option: TableSelectOptionInput) =>
    saved.options.find((candidate) => matches(option, candidate));
  const represented = new Set(
    sent.options.flatMap((option) => {
      const server = serverFor(option);
      return server ? [server] : [];
    })
  );
  const discovered = saved.options.filter((option) => !represented.has(option));
  const currentLabels = new Map<string, string | null>();
  const options = current.options.map((option) => {
    const original = sent.options.find((candidate) => matches(option, candidate));
    const server = original
      ? serverFor(original)
      : discovered.find(
          (candidate) =>
            (!!option.id && candidate.id === option.id) ||
            candidate.label.toLowerCase() === option.label.toLowerCase()
        );
    const next = server
      ? {
          ...option,
          id: server.id ?? option.id,
          label: original && option.label === original.label ? server.label : option.label,
          color:
            original && option.color === original.color
              ? server.color
              : (option.color ?? server.color),
        }
      : option;
    currentLabels.set(option.label, next.label);
    return next;
  });
  for (const option of discovered) {
    if (
      !options.some(
        (candidate) =>
          (option.id && option.id === candidate.id) ||
          candidate.label.toLowerCase() === option.label.toLowerCase()
      )
    )
      options.push(option);
  }
  const serverLabels = new Map(
    saved.options.map((option) => {
      const kept = options.find((candidate) => matches(option, candidate));
      return [option.label, kept?.label ?? null] as const;
    })
  );
  return {
    options,
    defaultValue: sameDefault(current.defaultValue, sent.defaultValue)
      ? mapDefault(saved.defaultValue, serverLabels)
      : mapDefault(current.defaultValue, currentLabels),
  };
}
