import {
  TABLE_REFERENCE_ID_PATTERN,
  TABLE_REFERENCE_KIND_NAMES,
  TABLE_REFERENCE_KINDS,
  type TableReferenceKind,
} from '../types/table-references';

export function isTableReferenceKind(value: unknown): value is TableReferenceKind {
  return TABLE_REFERENCE_KINDS.some((kind) => kind === value);
}

/** `doc` / `docs`, `Board post` / `Board posts`, … */
export function tableReferenceKindName(kind: TableReferenceKind, plural = false): string {
  const names = TABLE_REFERENCE_KIND_NAMES[kind];
  return plural ? names.plural : names.singular;
}

/** `a doc`, `an agent`, `an image`. */
export function tableReferenceKindArticle(kind: TableReferenceKind): string {
  const name = tableReferenceKindName(kind);
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** Chip href schemes that may wrap a Snaglet item id (`project:container-…`, `page:<uuid>`). */
const ITEM_SCHEMES = /^(?:page|doc|task|project|container|thread|image|post|agent):(.+)$/;

/** A chip: `[label](href)`, the label's brackets and backslashes escaped. */
const CHIP = /\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/y;

/** The item id a chip href names: the href itself, or what follows a known scheme. */
function hrefItemId(href: string): string | null {
  const id = ITEM_SCHEMES.exec(href)?.[1] ?? href;
  return TABLE_REFERENCE_ID_PATTERN.test(id) ? id : null;
}

/**
 * The Snaglet item ids a text value names, in order: chips (`[Title](doc-…)`, the
 * form Reference → Text conversion writes) and bare ids, separated by commas
 * or whitespace. Null when anything else is in the text; `[]` for blank text.
 */
export function tableReferenceIdsInText(text: string): string[] | null {
  const ids: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (/[\s,]/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '[') {
      CHIP.lastIndex = index;
      const chip = CHIP.exec(text);
      const id = chip ? hrefItemId(chip[2] ?? '') : null;
      if (!chip || id === null) return null;
      ids.push(id);
      index = CHIP.lastIndex;
      continue;
    }
    const end = text.slice(index).search(/[\s,]/);
    const token = end < 0 ? text.slice(index) : text.slice(index, index + end);
    if (!TABLE_REFERENCE_ID_PATTERN.test(token)) return null;
    ids.push(token);
    index += token.length;
  }
  return ids;
}

/** The id a value that is exactly one chip names; any other value is returned as is. */
export function unwrapTableReferenceChip(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  const ids = tableReferenceIdsInText(trimmed);
  return ids?.length === 1 && trimmed.endsWith(')') ? (ids[0] ?? value) : value;
}

/** Chip markdown for an item: `[Title](id)`, the title's brackets and backslashes escaped. */
export function tableReferenceChip(id: string, title: string): string {
  const label = title.replace(/[\r\n]+/g, ' ').replace(/[[\]\\]/g, '\\$&');
  return `[${label}](${id})`;
}
