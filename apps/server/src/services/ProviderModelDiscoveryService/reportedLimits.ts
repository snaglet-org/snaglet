import type { DiscoveredModel } from './types';

const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * The limits a provider's list endpoint stated for one model, keeping only
 * positive whole numbers. Persistence writes these over stored values.
 */
export function reportedLimits(
  contextWindowTokens: unknown,
  maxOutputTokens: unknown
): NonNullable<DiscoveredModel['reportedLimits']> {
  return {
    ...(isLimit(contextWindowTokens) ? { contextWindowTokens } : {}),
    ...(isLimit(maxOutputTokens) ? { maxOutputTokens } : {}),
  };
}
