import {
  asFiniteNumber,
  asNonEmptyString,
  asStringArray,
  capitalize,
  clamp,
  clampInt,
  elapsedMs,
  escapeRegex,
  escapeXml,
  flattenTextBlocks,
  formatClockTime,
  formatDateTime,
  formatShortDate,
  isHttpUrl,
  isRecord,
  isoNow,
  isoStamp,
  relativeFromNow,
  requireString,
  slugifyAgentName,
  toSnakeCase,
  unique,
  wordCount,
} from '@snaglet/shared/utils';

/**
 * Coverage for shared utility functions that the existing
 * `utils.test.ts` suite does not exercise. Behavior here is asserted
 * against the real implementations (not assumptions) — several of these
 * have sharp edges worth pinning down (e.g. `Number(null) === 0`, the
 * `??`-then-`Number` order in `clampInt`, and `&`-first escaping in
 * `escapeXml`).
 */

describe('arrays · unique', () => {
  it('removes duplicate primitives, preserving first-occurrence order', () => {
    expect(unique([1, 1, 2, 3, 3, 2])).toEqual([1, 2, 3]);
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    expect(unique(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty input', () => {
    expect(unique([])).toEqual([]);
  });

  it('accepts any iterable, not just arrays', () => {
    expect(unique(new Set([1, 2, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('uses reference (===) equality for objects', () => {
    const obj = { id: 1 };
    expect(unique([obj, obj])).toHaveLength(1);
    expect(unique([{ id: 1 }, { id: 1 }])).toHaveLength(2);
  });
});

describe('math · clamp', () => {
  it('returns the value when it sits inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to the bounds when out of range', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('handles negative ranges and equal bounds', () => {
    expect(clamp(-7, -10, -1)).toBe(-7);
    expect(clamp(-20, -10, -1)).toBe(-10);
    expect(clamp(5, 5, 5)).toBe(5);
  });
});

describe('numbers · asFiniteNumber', () => {
  it('returns finite numbers and numeric strings as-is', () => {
    expect(asFiniteNumber(42, 0)).toBe(42);
    expect(asFiniteNumber('3.14', 0)).toBe(3.14);
    expect(asFiniteNumber('  10  ', 0)).toBe(10);
  });

  it('falls back for NaN, Infinity, and non-numeric strings', () => {
    expect(asFiniteNumber('abc', 7)).toBe(7);
    expect(asFiniteNumber(NaN, 1)).toBe(1);
    expect(asFiniteNumber(Infinity, 9)).toBe(9);
    expect(asFiniteNumber(undefined, 5)).toBe(5);
  });

  it('coerces null and empty string to 0 (Number() semantics), not the fallback', () => {
    expect(asFiniteNumber(null, 5)).toBe(0);
    expect(asFiniteNumber('', 5)).toBe(0);
  });
});

describe('numbers · clampInt', () => {
  it('floors and clamps a value into [min, max]', () => {
    expect(clampInt(5, 20, 1, 50)).toBe(5);
    expect(clampInt(3.9, 20, 1, 50)).toBe(3);
    expect(clampInt(100, 20, 1, 50)).toBe(50);
    expect(clampInt(-5, 20, 1, 50)).toBe(1);
    expect(clampInt('30', 20, 1, 50)).toBe(30);
  });

  it('uses the fallback when the value is nullish', () => {
    expect(clampInt(undefined, 20, 1, 50)).toBe(20);
    expect(clampInt(null, 20, 1, 50)).toBe(20);
  });

  it('uses the fallback when the value is present but non-numeric', () => {
    expect(clampInt('abc', 20, 1, 50)).toBe(20);
  });

  it('treats 0 as a real value (not nullish)', () => {
    expect(clampInt(0, 20, 1, 50)).toBe(1);
  });
});

describe('type-guards · isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('type-guards · asNonEmptyString', () => {
  it('returns the trimmed string when non-empty', () => {
    expect(asNonEmptyString('hi')).toBe('hi');
    expect(asNonEmptyString('  spaced  ')).toBe('spaced');
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(asNonEmptyString('')).toBeNull();
    expect(asNonEmptyString('   ')).toBeNull();
    expect(asNonEmptyString(42)).toBeNull();
    expect(asNonEmptyString(null)).toBeNull();
    expect(asNonEmptyString(undefined)).toBeNull();
  });
});

describe('type-guards · asStringArray', () => {
  it('keeps only string elements (without trimming)', () => {
    expect(asStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(asStringArray(['a', 1, null, 'b', undefined])).toEqual(['a', 'b']);
    expect(asStringArray(['  keep spaces  '])).toEqual(['  keep spaces  ']);
  });

  it('returns an empty array for non-array input', () => {
    expect(asStringArray('a')).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray([])).toEqual([]);
  });
});

describe('type-guards · requireString', () => {
  it('returns the trimmed value for a present non-empty string', () => {
    expect(requireString({ name: 'Sam' }, 'name')).toBe('Sam');
    expect(requireString({ name: '  Sam  ' }, 'name')).toBe('Sam');
  });

  it('throws "<key> is required" when missing, empty, or non-string', () => {
    expect(() => requireString({}, 'name')).toThrow('name is required');
    expect(() => requireString({ name: '' }, 'name')).toThrow('name is required');
    expect(() => requireString({ name: '   ' }, 'name')).toThrow('name is required');
    expect(() => requireString({ name: 42 }, 'name')).toThrow('name is required');
  });
});

describe('strings · toSnakeCase', () => {
  it('lowercases and replaces whitespace/hyphen runs with single underscores', () => {
    expect(toSnakeCase('Library Create Page')).toBe('library_create_page');
    expect(toSnakeCase('  Hello World  ')).toBe('hello_world');
    expect(toSnakeCase('foo-bar baz')).toBe('foo_bar_baz');
    expect(toSnakeCase('Multiple   Spaces')).toBe('multiple_spaces');
  });

  it('leaves existing underscores intact', () => {
    expect(toSnakeCase('Already_Snake')).toBe('already_snake');
  });
});

describe('strings · slugifyAgentName', () => {
  it('lowercases and joins non-alphanumeric runs with a single hyphen', () => {
    expect(slugifyAgentName('Sam')).toBe('sam');
    expect(slugifyAgentName('My Agent')).toBe('my-agent');
    expect(slugifyAgentName('Foo!!! Bar')).toBe('foo-bar');
  });

  it('trims leading/trailing hyphens and strips non-ascii', () => {
    expect(slugifyAgentName('  Spaced  ')).toBe('spaced');
    expect(slugifyAgentName('Café')).toBe('caf');
  });

  it('returns an empty string when no usable characters remain', () => {
    expect(slugifyAgentName('---')).toBe('');
    expect(slugifyAgentName('')).toBe('');
  });
});

describe('strings · isHttpUrl', () => {
  it('accepts http and https urls (case-insensitive scheme)', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com/path?q=1')).toBe(true);
    expect(isHttpUrl('HTTP://EXAMPLE.COM')).toBe(true);
  });

  it('rejects other schemes and non-urls', () => {
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('mailto:a@b.com')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('strings · capitalize', () => {
  it('uppercases the first character only', () => {
    expect(capitalize('hello world')).toBe('Hello world');
    expect(capitalize('fooBar')).toBe('FooBar');
    expect(capitalize('a')).toBe('A');
  });

  it('returns the input unchanged when empty or non-alphabetic', () => {
    expect(capitalize('')).toBe('');
    expect(capitalize('123')).toBe('123');
  });
});

describe('strings · flattenTextBlocks', () => {
  it('joins block text with blank-line separators', () => {
    expect(flattenTextBlocks([{ text: 'a' }, { text: 'b' }])).toBe('a\n\nb');
  });

  it('handles single and empty block lists', () => {
    expect(flattenTextBlocks([{ text: 'solo' }])).toBe('solo');
    expect(flattenTextBlocks([])).toBe('');
  });
});

describe('strings · escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(x)')).toBe('\\(x\\)');
    expect(escapeRegex('plain text 123')).toBe('plain text 123');
  });

  it('produces a literal-matching pattern when fed to RegExp', () => {
    const re = new RegExp(escapeRegex('a.b'));
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });
});

describe('text · wordCount', () => {
  it('counts whitespace-delimited words across runs and newlines', () => {
    expect(wordCount('hello world')).toBe(2);
    expect(wordCount('  one   two  three ')).toBe(3);
    expect(wordCount('line1\nline2')).toBe(2);
    expect(wordCount('single')).toBe(1);
  });

  it('returns 0 for empty or whitespace-only strings', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
  });
});

describe('text · escapeXml', () => {
  it('escapes each of the five XML predefined entities', () => {
    expect(escapeXml('&')).toBe('&amp;');
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    expect(escapeXml("'")).toBe('&apos;');
  });

  it('escapes ampersands first so existing entities are not double-escaped', () => {
    expect(escapeXml('5 < 6 & "yes"')).toBe('5 &lt; 6 &amp; &quot;yes&quot;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('dateTime · relativeFromNow', () => {
  it('renders seconds/minutes/hours/days buckets', () => {
    expect(relativeFromNow(new Date(Date.now() - 5_000).toISOString())).toBe('5s ago');
    expect(relativeFromNow(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(relativeFromNow(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(relativeFromNow(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('clamps future timestamps to "0s ago"', () => {
    expect(relativeFromNow(new Date(Date.now() + 100_000).toISOString())).toBe('0s ago');
  });

  it('falls back to an absolute short date past a week', () => {
    const longAgo = relativeFromNow(new Date(Date.now() - 30 * 86_400_000).toISOString());
    expect(longAgo).not.toContain('ago');
    expect(longAgo.length).toBeGreaterThan(0);
  });

  it('returns the original string verbatim when unparseable', () => {
    expect(relativeFromNow('not-a-date')).toBe('not-a-date');
  });
});

describe('dateTime · formatDateTime', () => {
  it('composes short date + clock time for valid inputs', () => {
    const d = new Date('2024-12-08T14:30:00Z');
    expect(formatDateTime(d)).toBe(`${formatShortDate(d)} ${formatClockTime(d)}`);
  });

  it('accepts ISO strings and epoch ms', () => {
    expect(formatDateTime('2024-12-08T14:30:00Z')).toMatch(/\d{1,2}:\d{2}/);
    expect(formatDateTime(0)).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns the stringified input when it is not a valid date', () => {
    expect(formatDateTime('garbage')).toBe('garbage');
  });
});

describe('dateTime · elapsedMs', () => {
  it('returns a small non-negative value for "now"', () => {
    const e = elapsedMs(Date.now());
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThan(1_000);
  });

  it('measures elapsed time since a past start', () => {
    const e = elapsedMs(Date.now() - 1_000);
    expect(e).toBeGreaterThanOrEqual(1_000);
    expect(e).toBeLessThan(2_000);
  });

  it('is negative for a future start', () => {
    expect(elapsedMs(Date.now() + 10_000)).toBeLessThan(0);
  });
});

describe('dateTime · isoNow', () => {
  it('returns a UTC ISO 8601 timestamp that round-trips', () => {
    const now = isoNow();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(now).getTime())).toBe(false);
  });
});

describe('dateTime · isoStamp', () => {
  it('normalizes epoch ms, Date, and ISO strings to ISO 8601', () => {
    expect(isoStamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoStamp(new Date('2024-06-01T12:00:00.000Z'))).toBe('2024-06-01T12:00:00.000Z');
    expect(isoStamp('2024-06-01T12:00:00Z')).toBe('2024-06-01T12:00:00.000Z');
  });
});
