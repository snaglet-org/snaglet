import { TABLE_NAME_MAX_LENGTH } from '../types/tables';

/**
 * PostgreSQL reserved words (`pg_get_keywords()` category R). Custom table and
 * field names are real SQL identifiers, so they may not need quoting.
 */
const RESERVED_SQL_WORDS: ReadonlySet<string> = new Set(
  (
    'all analyse analyze and any array as asc asymmetric both case cast check collate column ' +
    'constraint create current_catalog current_date current_role current_time current_timestamp ' +
    'current_user default deferrable desc distinct do else end except false fetch for foreign ' +
    'from grant group having in initially intersect into lateral leading limit localtime ' +
    'localtimestamp not null offset on only or order placing primary references returning ' +
    'select session_user some symmetric system_user table then to trailing true union unique ' +
    'user using variadic when where window with'
  ).split(' ')
);

/** System columns every custom table has; field names may not reuse them. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['id', 'created_at', 'position']);

/**
 * What a table or field name input fixes as the user types or pastes:
 * capitals A–Z become lowercase and each run of whitespace becomes one `_`,
 * so `Work Experience` becomes `work_experience`. No other character is
 * dropped or changed, and nothing is trimmed or added, so whatever is still
 * wrong (a `-`, an accented letter, a leading digit or `_`) is left for
 * {@link tableNameProblem} to report.
 *
 * Formatting a prefix of the text gives a prefix of the formatted whole,
 * which is what lets an input keep the caret beside what the user typed.
 */
export function formatTableName(value: string): string {
  return value.replace(/\s+/g, '_').replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Naming policy shared by the UI, server and agent tools. A custom table's
 * name is its real PostgreSQL table name in `user_tables`, and a field's name is
 * its real column name, so both are lowercase snake_case identifiers that
 * start with a letter and never need quoting in SQL.
 */
export function tableNameProblem(value: string, kind: 'table' | 'field' = 'table'): string | null {
  const name = value.trim();
  const Kind = kind === 'table' ? 'Table' : 'Field';
  if (!name) return `Enter a ${kind} name.`;
  if (name.length > TABLE_NAME_MAX_LENGTH) {
    return `${Kind} names can be at most ${TABLE_NAME_MAX_LENGTH} characters.`;
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    return 'Use only lowercase letters, numbers, and underscores, like work_experience.';
  }
  if (!/^[a-z]/.test(name)) return `Start the ${kind} name with a lowercase letter.`;
  if (RESERVED_SQL_WORDS.has(name)) return `"${name}" is a reserved SQL word. Choose another name.`;
  if (kind === 'field' && RESERVED_FIELD_NAMES.has(name)) {
    return `"${name}" is a system column every table already has. Choose another name.`;
  }
  return null;
}
