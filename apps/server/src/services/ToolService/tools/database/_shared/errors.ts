import { getErrorMessage, isRecord } from '@snaglet/shared/utils';

const MESSAGE_MAX = 400;
const DETAIL_MAX = 80;
const DETAIL_ITEMS = 3;
/** Agents address tables and fields by name and never see revisions; SQL errors already say what failed. */
const HIDDEN_DETAILS = new Set([
  'schemaVersion',
  'revision',
  'expectedRevision',
  'tableId',
  'fieldId',
  'sqlState',
]);

interface StatusError extends Error {
  statusCode: number;
  details?: unknown;
}

/** The PostgreSQL SQLSTATE code on a driver error, if it carries one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}

function isStatusError(err: unknown): err is StatusError {
  return err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

interface LinkReference {
  tableName: string;
  fieldName: string;
  count: number;
}

function linkReferences(details: unknown): LinkReference[] | null {
  if (!isRecord(details) || !Array.isArray(details.references)) return null;
  const refs = details.references.filter(
    (ref): ref is LinkReference =>
      isRecord(ref) &&
      typeof ref.tableName === 'string' &&
      typeof ref.fieldName === 'string' &&
      typeof ref.count === 'number'
  );
  return refs.length ? refs : null;
}

function linksMessage(refs: LinkReference[]): string {
  const total = refs.reduce((sum, ref) => sum + ref.count, 0);
  const where = refs.map((ref) => `${ref.tableName}.${ref.fieldName} (${ref.count})`).join(', ');
  return (
    `${total} ${plural(total, 'link points', 'links point')} to the selected entries: ${where}. ` +
    'Repeat with clear_links:true to remove them.'
  );
}

/** Field-level validation errors or scalar context; nested objects are never dumped. */
function detailSuffix(details: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(details)) {
    for (const item of details) {
      if (isRecord(item) && typeof item.message === 'string') {
        const field = typeof item.field === 'string' && item.field ? `${item.field}: ` : '';
        parts.push(oneLine(`${field}${item.message}`, DETAIL_MAX));
      }
    }
  } else if (isRecord(details)) {
    // A write conflict's message does not say which row; its current rev lets the agent retry.
    const entry = details.entry;
    if (isRecord(entry) && typeof entry.id === 'string') {
      parts.push(
        `entry ${entry.id}${typeof entry.rev === 'string' ? ` is at rev ${entry.rev}` : ''}`
      );
    }
    for (const [key, value] of Object.entries(details)) {
      if (HIDDEN_DETAILS.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        parts.push(oneLine(`${key}=${String(value)}`, DETAIL_MAX));
      }
    }
  }
  if (!parts.length) return '';
  const shown = parts.slice(0, DETAIL_ITEMS);
  const more = parts.length > shown.length ? `; +${parts.length - shown.length} more` : '';
  return ` (${shown.join('; ')}${more})`;
}

/** One line per failure: `error <status>: <message>`, never a stack or a JSON dump. */
function renderToolError(err: unknown): string {
  const status = isStatusError(err) ? err.statusCode : 500;
  const details = isStatusError(err) ? err.details : undefined;
  const refs = status === 409 ? linkReferences(details) : null;
  if (refs) return `error 409: ${linksMessage(refs)}`;
  const message = oneLine(getErrorMessage(err), MESSAGE_MAX) || 'table operation failed';
  return `error ${status}: ${message}${detailSuffix(details)}`;
}

/**
 * Throwing marks the call failed (is_error for the model, isError over MCP)
 * while the text stays the single rendered line.
 */
export async function runTableTool<T = string>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    throw new Error(renderToolError(err));
  }
}
