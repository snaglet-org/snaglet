import { escapeRegex } from '@snaglet/shared/utils';

export interface TextMatch {
  from: number;
  to: number;
}

/** Literal, non-overlapping matches. Regex keeps offsets in the original UTF-16 text. */
export function findText(text: string, query: string, caseSensitive = false): TextMatch[] {
  if (!query) return [];
  const pattern = new RegExp(escapeRegex(query), caseSensitive ? 'gu' : 'giu');
  return Array.from(text.matchAll(pattern), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

export function replaceText(
  text: string,
  matches: readonly TextMatch[],
  replacement: string
): string {
  let next = text;
  for (const match of [...matches].reverse()) {
    next = next.slice(0, match.from) + replacement + next.slice(match.to);
  }
  return next;
}
