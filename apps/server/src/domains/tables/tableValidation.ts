/**
 * Runtime validation for Database table requests. Shared by the route (which
 * rejects malformed bodies before touching the service) and the service
 * (which re-validates, since non-HTTP callers reach it too).
 */

import {
  AUTOMATIONS_TABLE_ID,
  BUILTIN_TABLE_ID_PREFIX,
  CUSTOM_TABLE_ID_PATTERN,
  ErrorCode,
  HTTP_STATUS,
  TABLE_NAME_MAX_LENGTH,
  TABLE_ORIGINS,
  TABLE_PROJECT_FILTER_NONE,
  type TableOrigin,
  type TableProjectFilter,
} from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function tableBadRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/**
 * Automations change only through AutomationService (the automation
 * tool, or the grid's row actions and Edit form); the generic table writers
 * refuse that table.
 */
export function refuseAutomationsTable(tableId: string | null | undefined): void {
  if (tableId === AUTOMATIONS_TABLE_ID) {
    throw new AppError('Use the automation tool.', ErrorCode.FORBIDDEN, HTTP_STATUS.FORBIDDEN);
  }
}

/** A client-minted custom id (see CUSTOM_TABLE_ID_PATTERN), or a 400. */
export function parseCustomTableId(value: unknown): string {
  if (typeof value !== 'string' || !CUSTOM_TABLE_ID_PATTERN.test(value)) {
    throw tableBadRequest('id must be a table id of the form table-<13 digits>-<suffix>');
  }
  if (value.startsWith(BUILTIN_TABLE_ID_PREFIX)) {
    throw tableBadRequest(`id may not use the reserved ${BUILTIN_TABLE_ID_PREFIX} prefix`);
  }
  return value;
}

/**
 * Basic request shape, including previously accepted names for exact retries.
 * The create service applies the stricter shared policy to new tables only.
 */
export function parseTableName(value: unknown): string {
  if (typeof value !== 'string') throw tableBadRequest('name must be a string');
  const name = value.trim();
  if (!name) throw tableBadRequest('name must not be empty');
  if (name.length > TABLE_NAME_MAX_LENGTH) {
    throw tableBadRequest(`name must be at most ${TABLE_NAME_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw tableBadRequest('name must not contain control characters');
  }
  return name;
}

/** Optional `?origin=` filter: absent → undefined, otherwise a known origin or a 400. */
export function parseTableOriginFilter(value: unknown): TableOrigin | undefined {
  if (value === undefined) return undefined;
  const match = TABLE_ORIGINS.find((origin) => origin === value);
  if (!match) throw tableBadRequest(`origin must be one of: ${TABLE_ORIGINS.join(', ')}`);
  return match;
}

/**
 * One project id, as the list filter and the link body both take it: trimmed,
 * non-empty and free of control characters (400 otherwise). `none` in any
 * case is the list filter's "no project home" value and comes back as
 * `TABLE_PROJECT_FILTER_NONE`; a body says `null` instead, so there it is a
 * 400 that points at `null`.
 */
function parseProjectIdString(value: unknown, opts: { allowNone: boolean }): string {
  const alternative = opts.allowNone ? TABLE_PROJECT_FILTER_NONE : 'null';
  if (typeof value !== 'string' || !value.trim()) {
    throw tableBadRequest(`projectId must be a project container id or ${alternative}`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw tableBadRequest('projectId must not contain control characters');
  }
  const id = value.trim();
  if (id.toLowerCase() !== TABLE_PROJECT_FILTER_NONE) return id;
  if (opts.allowNone) return TABLE_PROJECT_FILTER_NONE;
  throw tableBadRequest(
    `projectId must be a project container id or null (${TABLE_PROJECT_FILTER_NONE} is the list filter)`
  );
}

/**
 * Optional `?projectId=` filter: absent → undefined, `none` (any case) →
 * workspace-wide tables only, otherwise a project container id. A repeated,
 * empty or control-character value is a 400.
 */
export function parseTableProjectFilter(value: unknown): TableProjectFilter | undefined {
  if (value === undefined) return undefined;
  return parseProjectIdString(value, { allowNone: true });
}

/**
 * A project link target in a body: a project container id, or null for the
 * workspace level. `none` is the list filter, not a body value (400).
 */
export function parseTableProjectId(value: unknown): string | null {
  if (value === null) return null;
  return parseProjectIdString(value, { allowNone: false });
}

/** A table's slot in its list: a non-negative integer (0 = top), or a 400. */
export function parseTableSortOrder(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw tableBadRequest('sortOrder must be a non-negative integer (0 = top of the list)');
  }
  return value;
}

/** A positive integer query or body value (`"3"` or `3`), or undefined when absent. */
export function pageNumber(input: unknown, name: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string' && /^[1-9]\d*$/.test(input)) input = Number(input);
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1)
    throw tableBadRequest(`${name} must be a positive integer.`);
  return input;
}

/** A non-negative `offset` (`"0"` or `0`), or undefined when absent. */
export function offsetNumber(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string' && /^(0|[1-9]\d*)$/.test(input)) input = Number(input);
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
    throw tableBadRequest('offset must be a non-negative integer.');
  return input;
}

/** Comma-separated (`a,b`) or repeated (`x=a&x=b`) query values; empty parts are dropped. */
export function idList(input: unknown, name: string, what: string): string[] | undefined {
  if (input === undefined) return undefined;
  const parts = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string'))
    throw tableBadRequest(`${name} must be a comma-separated list of ${what}.`);
  return parts.flatMap((part: string) => part.split(',')).filter((id) => id !== '');
}
