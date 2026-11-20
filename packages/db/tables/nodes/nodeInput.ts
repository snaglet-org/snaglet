/**
 * Up-front input checks for the node-backed model write paths. Each throws a
 * 400 AppError before any statement runs, so a bad value reaches the caller as
 * a clear client error instead of a PostgreSQL failure part-way through a
 * multi-statement write.
 */

import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';

export function nodeInputError(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * True for an ISO 8601 date or date-time naming a real calendar day. The
 * shape check keeps out the free-form strings `Date.parse` tolerates but a
 * `timestamptz` column rejects; the calendar check keeps out days like
 * 2026-02-30 that some parsers roll over.
 */
function isIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

/** Reject a present, non-null timestamp field that is not an ISO 8601 date. */
export function assertTimestampInput(
  field: string,
  value: unknown
): asserts value is string | null | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !isIsoTimestamp(value)) {
    throw nodeInputError(
      `${field} must be an ISO 8601 date or date-time (e.g. 2026-10-01T17:00:00Z), got ${JSON.stringify(value)}`
    );
  }
}

/** Reject a present sort order the integer `nodes.sort_order` column would refuse. */
export function assertSortOrderInput(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw nodeInputError(`sortOrder must be an integer, got ${JSON.stringify(value)}`);
  }
}
