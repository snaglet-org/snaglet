/**
/**
 * Classifying Postgres errors at catch sites. A catch that logs and continues
 * suits transient errors, but a code/schema mismatch (undefined column or
 * table, syntax error) never heals on retry, and swallowing it turns a bug into
 * silently empty results. Call `rethrowIfProgrammerError` first in any catch
 * that swallows transient errors.
 */

/**
 * SQLSTATE codes for SQL that doesn't fit the deployed schema (mostly class
 * 42). Listed one by one rather than `startsWith('42')` so it is clear what
 * is caught.
 */
const PROGRAMMER_BUG_SQLSTATES: ReadonlySet<string> = new Set([
  '42703', // undefined_column
  '42P01', // undefined_table
  '42601', // syntax_error
  '42883', // undefined_function
  '42704', // undefined_object  (covers types, indexes, schemas)
  '42P02', // undefined_parameter
  '42846', // cannot_coerce
  '42P18', // indeterminate_datatype
]);

/**
 * Re-throw `err` if it is a Postgres programmer-bug error; otherwise return so
 * the caller's log-and-continue path runs:
 *
 * ```ts
 * } catch (err) {
 *   rethrowIfProgrammerError(err);  // surfaces 42703 etc.
 *   logger.warn('transient failure, skipping:', err);
 * }
 * ```
 */
export function rethrowIfProgrammerError(err: unknown): void {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && PROGRAMMER_BUG_SQLSTATES.has(code)) {
      throw err;
    }
  }
}
