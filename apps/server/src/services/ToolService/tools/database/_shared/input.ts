import { ErrorCode, HTTP_STATUS, type TableEntryValue } from '@snaglet/shared/types';
import { AppError, isRecord } from '@snaglet/shared/utils';

/** ToolExecutor does not apply the JSON schema, so every handler validates its own input. */
export function badInput(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

export function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw badInput(`${path} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, path);
}

export function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw badInput(`${path} must be true or false`);
  return value;
}

export function optionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badInput(`${path} must be an integer ${min}-${max}`);
  }
  return value;
}

export function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw badInput(`${path} must be an object`);
  return value;
}

export function optionalArray(value: unknown, path: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badInput(`${path} must be an array`);
  return value;
}

export function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badInput(`${path} must be a non-empty array of strings`);
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

/** Nested shapes are closed so a misplaced key fails loudly instead of being dropped. */
export function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  hint = ''
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown === undefined) return;
  // Without a hint, name the keys that are allowed so the next call can succeed.
  throw badInput(`${path}: unknown key "${unknown}"${hint || ` (allowed: ${allowed.join(', ')})`}`);
}

/**
 * Numbers arrive as JSON numbers despite the decimal-string contract; convert
 * the ones that survive the round trip exactly rather than spend a retry.
 */
export function numberAsDecimal(value: number, path: string): string {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw badInput(`${path}: pass this number as a decimal string`);
  }
  return String(value);
}

function entryValue(value: unknown, path: string): TableEntryValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return numberAsDecimal(value, path);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw badInput(`${path} must be a string, boolean, null or array of entry ids or labels`);
}

export function entryValues(value: unknown, path: string): Record<string, TableEntryValue> {
  const values = objectAt(value, path);
  const out: Record<string, TableEntryValue> = {};
  for (const [field, raw] of Object.entries(values)) {
    // Field names are data; a plain assignment would let `__proto__` rewire the object.
    Object.defineProperty(out, field, {
      value: entryValue(raw, `${path}.${field}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
