/**
 * Shared text utilities used by both frontend and backend
 */

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function withLineNumbers(content: string): string {
  const lines = content.split('\n');
  const pad = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(pad)}│ ${line}`).join('\n');
}

/** Truncate a string to `max` characters, appending "..." if trimmed. */
export function truncate(value: unknown, max: number): string {
  const str = typeof value === 'string' ? value : String(value ?? '');
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** Extract the first character of a name as an uppercase initial, with fallback. */
export function getInitial(name: string, fallback = '?'): string {
  return (name.trim()[0] ?? fallback).toUpperCase();
}

/** Extract up to `max` initials from a multi-word name. */
export function getInitials(name: string, max = 2): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part[0] ?? '').toUpperCase())
    .join('')
    .slice(0, max);
}

/**
 * Escape a string for safe inclusion in XML/SVG content.
 * Handles the 5 XML predefined nodes.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface FindReplaceResult {
  updated: string;
  occurrences: number;
}

export interface FindReplaceOptions {
  /** Throw when no match exists (default: true). */
  requireMatch?: boolean;
  /** Throw when more than one match exists (default: true). */
  requireSingleMatch?: boolean;
  /** Custom message when no match exists. */
  noMatchMessage?: string;
  /** Custom message when multiple matches exist. */
  multipleMatchMessage?: string;
}

/**
 * Perform an exact text find/replace with optional safety checks.
 *
 * Examples:
 * - `findAndReplace('hello world', 'world', 'team')`
 * - `findAndReplace('a a', 'a', 'b', { requireSingleMatch: false })`
 */
export function findAndReplace(
  content: string,
  oldText: string,
  newText: string,
  options: FindReplaceOptions = {}
): FindReplaceResult {
  const {
    requireMatch = true,
    requireSingleMatch = true,
    noMatchMessage = 'old_text not found in content',
    multipleMatchMessage = 'old_text appears multiple times. Provide more specific context to match exactly once.',
  } = options;

  if (!oldText) {
    throw new Error('old_text is required');
  }
  if (oldText === newText) {
    throw new Error('old_text and new_text must be different');
  }

  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0 && requireMatch) {
    throw new Error(noMatchMessage);
  }
  if (occurrences > 1 && requireSingleMatch) {
    throw new Error(`${multipleMatchMessage} Found ${occurrences} matches.`);
  }

  return {
    updated: content.replace(oldText, newText),
    occurrences,
  };
}
