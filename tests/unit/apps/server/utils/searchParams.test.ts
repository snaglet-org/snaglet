import {
  parseDelimitedStringList,
  parseEnumList,
  parseEnumValue,
  parseIdList,
  parseOptionalNonEmptyString,
} from '@server/utils/searchParams';

describe('parseDelimitedStringList', () => {
  it('returns [] for null/undefined', () => {
    expect(parseDelimitedStringList(null)).toEqual([]);
    expect(parseDelimitedStringList(undefined)).toEqual([]);
  });

  it('passes through a real array, lowercased and trimmed', () => {
    expect(parseDelimitedStringList(['Doc', ' Task ', 'message'])).toEqual([
      'doc',
      'task',
      'message',
    ]);
  });

  it('splits a comma-delimited string', () => {
    expect(parseDelimitedStringList('doc, task ,message')).toEqual(['doc', 'task', 'message']);
  });

  // Smaller models (e.g. Haiku) serialize array params as a JSON string.
  it('tolerates a JSON-stringified array', () => {
    expect(parseDelimitedStringList('["doc", "task", "message"]')).toEqual([
      'doc',
      'task',
      'message',
    ]);
  });

  it('tolerates a JSON-stringified array without spaces', () => {
    expect(parseDelimitedStringList('["doc","task"]')).toEqual(['doc', 'task']);
  });

  it('falls back to bracket-strip + comma-split for malformed JSON arrays', () => {
    // Unquoted values inside brackets are not valid JSON, but should still parse.
    expect(parseDelimitedStringList('[doc, task]')).toEqual(['doc', 'task']);
  });

  it('drops empty entries', () => {
    expect(parseDelimitedStringList('doc,,task,')).toEqual(['doc', 'task']);
    expect(parseDelimitedStringList('["doc", "", "task"]')).toEqual(['doc', 'task']);
  });
});

describe('parseEnumList', () => {
  const allowed = ['doc', 'task', 'thread'];

  it('keeps only allowed values, de-duplicated', () => {
    expect(parseEnumList('doc,task,doc', allowed, ['doc'])).toEqual(['doc', 'task']);
  });

  it('matches case-insensitively', () => {
    expect(parseEnumList('DOC', allowed, ['thread'])).toEqual(['doc']);
  });

  it('returns a copy of the fallback when nothing matches', () => {
    const fallback = ['doc', 'task'];
    const result = parseEnumList('bogus', allowed, fallback);
    expect(result).toEqual(['doc', 'task']);
    expect(result).not.toBe(fallback);
  });

  it('returns the fallback for nullish input', () => {
    expect(parseEnumList(null, allowed, ['thread'])).toEqual(['thread']);
  });
});

describe('parseEnumValue', () => {
  const allowed = ['asc', 'desc'];

  it('returns the normalized value when allowed', () => {
    expect(parseEnumValue(' DESC ', allowed, 'asc')).toBe('desc');
  });

  it('returns the fallback for disallowed or non-string input', () => {
    expect(parseEnumValue('sideways', allowed, 'asc')).toBe('asc');
    expect(parseEnumValue(42, allowed, 'desc')).toBe('desc');
    expect(parseEnumValue(null, allowed, 'asc')).toBe('asc');
  });
});

describe('parseIdList', () => {
  it('trims, drops empties, de-duplicates, and wraps a single string', () => {
    expect(parseIdList(['a', ' b ', '', 'a'])).toEqual(['a', 'b']);
    expect(parseIdList('solo')).toEqual(['solo']);
  });

  it('filters non-string elements', () => {
    expect(parseIdList(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(parseIdList(123)).toEqual([]);
  });

  it('caps the list at the max length', () => {
    expect(parseIdList(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });

  it('returns [] for nullish input', () => {
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe('parseOptionalNonEmptyString', () => {
  it('returns the trimmed string when non-empty', () => {
    expect(parseOptionalNonEmptyString('  hello  ')).toBe('hello');
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(parseOptionalNonEmptyString('')).toBeNull();
    expect(parseOptionalNonEmptyString('   ')).toBeNull();
    expect(parseOptionalNonEmptyString(42)).toBeNull();
    expect(parseOptionalNonEmptyString(null)).toBeNull();
  });
});
