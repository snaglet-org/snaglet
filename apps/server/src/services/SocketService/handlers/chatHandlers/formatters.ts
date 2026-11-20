/**
 * Pure formatting helpers used by chatHandlers.
 */

// ANSI color codes used for server-side log highlighting.

export const previewMessage = (value: string, max = 240): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
};

export const toToolText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
};
