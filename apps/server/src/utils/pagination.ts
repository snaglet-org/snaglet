import { clamp } from '@snaglet/shared/utils';

export type ClampLimitOptions = {
  defaultLimit?: number;
  defaultOnNonPositive?: boolean;
  min?: number;
  max?: number;
};

export function clampLimit(raw: unknown, options: ClampLimitOptions = {}): number {
  const defaultLimit = options.defaultLimit ?? 50;
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  const parsed =
    typeof raw === 'string' && raw.length > 0
      ? Number.parseInt(raw, 10)
      : typeof raw === 'number'
        ? raw
        : defaultLimit;
  if (!Number.isFinite(parsed)) return defaultLimit;
  const value = Math.floor(parsed);
  if (value <= 0 && options.defaultOnNonPositive !== false) return defaultLimit;
  return clamp(value, min, max);
}
