import { getErrorMessage, isRecord } from '@snaglet/shared/utils';

const MESSAGE_MAX = 400;
/** Row revisions are shown as this many leading hex characters, as the table tool shows them. */
export const ROW_REV_LENGTH = 8;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statusOf(err: unknown): number {
  const code = isRecord(err) || err instanceof Error ? Reflect.get(err, 'statusCode') : undefined;
  return typeof code === 'number' ? code : 500;
}

/**
 * A conflict names the item's current rev, so the agent can re-read or
 * retry: an event conflict carries the event, a row conflict the entry.
 */
function conflictSuffix(details: unknown): string {
  if (!isRecord(details)) return '';
  const { event, entry } = details;
  if (isRecord(event) && typeof event.id === 'string' && typeof event.revision === 'number')
    return ` (event ${event.id} is at rev ${event.revision})`;
  if (isRecord(entry) && typeof entry.id === 'string' && typeof entry.revision === 'string')
    return ` (row ${entry.id} is at rev ${entry.revision.slice(0, ROW_REV_LENGTH)})`;
  return '';
}

/** One line per failure, `error <status>: <message>`, never a stack or a JSON dump. */
function renderCalendarError(err: unknown): string {
  const status = statusOf(err);
  const details = isRecord(err) || err instanceof Error ? Reflect.get(err, 'details') : undefined;
  const message = oneLine(getErrorMessage(err), MESSAGE_MAX) || 'calendar operation failed';
  return `error ${status}: ${message}${status === 409 ? conflictSuffix(details) : ''}`;
}

/**
 * Runs one op and returns its result as compact JSON. Throwing marks the
 * call failed (is_error for the model) while the text stays one line.
 */
export async function runCalendarTool(action: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await action());
  } catch (err) {
    throw new Error(renderCalendarError(err));
  }
}
