import {
  asTrimmedString,
  camelToSnake,
  deduplicateBy,
  formatBytes,
  formatClockTime,
  formatClockTime24,
  formatClockTimeWithSeconds,
  formatLongDate,
  formatRelativeTime,
  formatShortDate,
  formatTimestamp,
  formatUptime,
  findAndReplace,
  parseIntervalToMs,
  sleep,
  startOfToday,
  generateId,
  getInitial,
  getInitials,
  normalizeStringArray,
  normalizeWhitespace,
  parseCsv,
  parseOptionalPositiveInt,
  readTrimmedString,
  recencyScore,
  requirePositiveInt,
  safeJsonParse,
  snippet,
  snakeToCamel,
  truncate,
  vectorLiteral,
  withLineNumbers,
} from '@snaglet/shared/utils';

describe('Shared Utilities', () => {
  describe('formatTimestamp', () => {
    it('should return ISO 8601 formatted string', () => {
      const date = new Date('2024-12-08T14:30:00.000Z');
      expect(formatTimestamp(date)).toBe('2024-12-08T14:30:00.000Z');
    });

    it('should include milliseconds', () => {
      const date = new Date('2024-01-15T10:30:45.123Z');
      expect(formatTimestamp(date)).toBe('2024-01-15T10:30:45.123Z');
    });

    it('should handle current date', () => {
      const now = new Date();
      const result = formatTimestamp(now);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should always return UTC timezone (Z suffix)', () => {
      const date = new Date('2024-06-15T12:00:00.000Z');
      const result = formatTimestamp(date);
      expect(result.endsWith('Z')).toBe(true);
    });
  });

  describe('formatShortDate', () => {
    it('should format date as a short en-US date', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(formatShortDate(date)).toBe('Jan 15, 2024');
    });

    it('should handle current date', () => {
      const now = new Date();
      const result = formatShortDate(now);
      expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    });
  });

  describe('positive integer parsing', () => {
    it('should allow undefined for optional values', () => {
      expect(parseOptionalPositiveInt(undefined, 'limit')).toBeUndefined();
      expect(parseOptionalPositiveInt(null, 'limit')).toBeUndefined();
    });

    it('should parse and floor positive numeric input', () => {
      expect(parseOptionalPositiveInt('4.9', 'limit')).toBe(4);
      expect(requirePositiveInt(3.2, 'page')).toBe(3);
    });

    it('should reject invalid positive integers', () => {
      expect(() => parseOptionalPositiveInt(0, 'limit')).toThrow(
        'limit must be a positive integer'
      );
      expect(() => parseOptionalPositiveInt('abc', 'limit')).toThrow(
        'limit must be a positive integer'
      );
      expect(() => requirePositiveInt(undefined, 'page')).toThrow(
        'page must be a positive integer'
      );
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    });

    it('should return fallback on invalid JSON', () => {
      expect(safeJsonParse('not json', [])).toEqual([]);
    });

    it('should return undefined without fallback on invalid JSON', () => {
      expect(safeJsonParse('not json')).toBeUndefined();
    });

    it('should parse arrays', () => {
      expect(safeJsonParse<string[]>('["a","b"]', [])).toEqual(['a', 'b']);
    });

    it('should handle empty string', () => {
      expect(safeJsonParse('', {})).toEqual({});
    });
  });

  describe('generateId', () => {
    it('should generate id with default prefix', () => {
      const id = generateId();
      expect(id).toMatch(/^id-\d+-[a-z0-9]{9}$/);
    });

    it('should generate id with custom prefix', () => {
      const id = generateId('error');
      expect(id.startsWith('error-')).toBe(true);
    });

    it('should generate unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('normalizeWhitespace', () => {
    it('should collapse multiple spaces', () => {
      expect(normalizeWhitespace('a  b   c')).toBe('a b c');
    });

    it('should collapse tabs and newlines', () => {
      expect(normalizeWhitespace('a\t\nb\n\nc')).toBe('a b c');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(normalizeWhitespace('  hello  ')).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(normalizeWhitespace('')).toBe('');
    });

    it('should handle single-space strings', () => {
      expect(normalizeWhitespace('already clean')).toBe('already clean');
    });
  });

  describe('line numbering and truncation', () => {
    it('should prefix each line with a line number', () => {
      expect(withLineNumbers('alpha\nbeta\ngamma')).toBe('1│ alpha\n2│ beta\n3│ gamma');
    });

    it('should pad line numbers when there are at least 10 lines', () => {
      const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n');
      expect(withLineNumbers(content).split('\n')[0]).toBe(' 1│ line-1');
    });

    it('should truncate values beyond the max length', () => {
      expect(truncate('abcdef', 3)).toBe('abc...');
      expect(truncate(123456, 4)).toBe('1234...');
    });
  });

  describe('findAndReplace', () => {
    it('replaces exactly one occurrence by default', () => {
      const result = findAndReplace('alpha beta gamma', 'beta', 'BETA');
      expect(result).toEqual({ updated: 'alpha BETA gamma', occurrences: 1 });
    });

    it('throws when old_text is not found', () => {
      expect(() => findAndReplace('alpha beta', 'missing', 'x')).toThrow(
        'old_text not found in content'
      );
    });

    it('throws when old_text appears multiple times', () => {
      expect(() => findAndReplace('x y x', 'x', 'z')).toThrow('Found 2 matches');
    });

    it('throws when old_text and new_text are identical', () => {
      expect(() => findAndReplace('alpha', 'alpha', 'alpha')).toThrow(
        'old_text and new_text must be different'
      );
    });

    it('supports replacing special characters and newlines', () => {
      const result = findAndReplace('line1\\nline2 [x]', 'line2 [x]', 'line2 [ok]');
      expect(result.updated).toBe('line1\\nline2 [ok]');
      expect(result.occurrences).toBe(1);
    });
  });

  describe('trim/string-array helpers', () => {
    it('should return trimmed strings for non-empty input', () => {
      expect(asTrimmedString('  hello  ')).toBe('hello');
      expect(asTrimmedString('   ')).toBeUndefined();
      expect(asTrimmedString(123)).toBeUndefined();
    });

    it('should read trimmed strings with empty-string fallback', () => {
      expect(readTrimmedString('  hello  ')).toBe('hello');
      expect(readTrimmedString(null)).toBe('');
    });

    it('should normalize string arrays', () => {
      expect(normalizeStringArray([' alpha ', '', ' beta', 5, '   '] as unknown)).toEqual([
        'alpha',
        'beta',
      ]);
    });
  });

  describe('string helpers', () => {
    it('should convert between snake_case and camelCase', () => {
      expect(snakeToCamel('library_node_tree')).toBe('libraryNodeTree');
      expect(camelToSnake('libraryNodeTree')).toBe('library_node_tree');
    });

    it('should extract initials from names', () => {
      expect(getInitial(' Ada ')).toBe('A');
      expect(getInitial('', '!')).toBe('!');
      expect(getInitials('Ada Lovelace Byron')).toBe('AL');
      expect(getInitials('single', 3)).toBe('S');
    });
  });

  describe('deduplicateBy', () => {
    it('should deduplicate by key function', () => {
      const items = [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 1, name: 'c' },
      ];
      const result = deduplicateBy(items, (item) => item.id);
      expect(result).toEqual([
        { id: 1, name: 'c' },
        { id: 2, name: 'b' },
      ]);
    });

    it('should return empty array for empty input', () => {
      expect(deduplicateBy([], (x) => x)).toEqual([]);
    });

    it('should keep last occurrence data for repeated primitive keys', () => {
      const result = deduplicateBy(['a', 'b', 'a'], (x) => x);
      expect(result).toEqual(['a', 'b']);
    });

    it('should work with string keys', () => {
      const items = [
        { type: 'x', val: 1 },
        { type: 'y', val: 2 },
        { type: 'x', val: 3 },
      ];
      const result = deduplicateBy(items, (item) => item.type);
      expect(result).toEqual([
        { type: 'x', val: 3 },
        { type: 'y', val: 2 },
      ]);
    });
  });

  describe('formatUptime', () => {
    it('should format zero seconds', () => {
      expect(formatUptime(0)).toBe('0s');
    });

    it('should format seconds only', () => {
      expect(formatUptime(45)).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      expect(formatUptime(125)).toBe('2m 5s');
    });

    it('should format hours, minutes, seconds', () => {
      expect(formatUptime(3661)).toBe('1h 1m 1s');
    });

    it('should format days', () => {
      expect(formatUptime(90061)).toBe('1d 1h 1m 1s');
    });

    it('should omit zero components', () => {
      expect(formatUptime(3600)).toBe('1h');
      expect(formatUptime(86400)).toBe('1d');
    });
  });

  describe('formatBytes', () => {
    it('should format zero bytes', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 Bytes');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });

    it('should format with decimal precision', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
    });
  });

  describe('snippet', () => {
    it('should return empty string for nullish input', () => {
      expect(snippet(null)).toBe('');
      expect(snippet(undefined)).toBe('');
    });

    it('should return short text as-is', () => {
      expect(snippet('hello world')).toBe('hello world');
    });

    it('should truncate at word boundary', () => {
      const long = 'word '.repeat(100);
      const result = snippet(long, 30);
      expect(result.length).toBeLessThanOrEqual(35); // maxLen + ellipsis char
      expect(result.endsWith('…')).toBe(true);
    });

    it('should normalize whitespace', () => {
      expect(snippet('a  b\n\nc')).toBe('a b c');
    });

    it('should respect custom maxLen', () => {
      const text = 'a '.repeat(200);
      expect(snippet(text, 10).length).toBeLessThanOrEqual(15);
    });
  });

  describe('vectorLiteral', () => {
    it('should format numeric array as vector literal', () => {
      expect(vectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    });

    it('should handle empty array', () => {
      expect(vectorLiteral([])).toBe('[]');
    });

    it('should handle single element', () => {
      expect(vectorLiteral([1.5])).toBe('[1.5]');
    });
  });

  describe('recencyScore', () => {
    it('should return 1 for just-created items', () => {
      const now = new Date().toISOString();
      expect(recencyScore(now)).toBeCloseTo(1, 1);
    });

    it('should return 0 for items older than the window', () => {
      const old = new Date(Date.now() - 121 * 24 * 60 * 60 * 1000).toISOString();
      expect(recencyScore(old)).toBe(0);
    });

    it('should return ~0.5 at half the window', () => {
      const halfWay = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      expect(recencyScore(halfWay)).toBeCloseTo(0.5, 1);
    });

    it('should accept a custom window', () => {
      const old = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
      expect(recencyScore(old, 90)).toBeGreaterThan(0);
      expect(recencyScore(old, 30)).toBe(0);
    });
  });

  describe('parseCsv', () => {
    it('should split comma-separated values', () => {
      expect(parseCsv('a, b, c')).toEqual(['a', 'b', 'c']);
    });

    it('should handle undefined', () => {
      expect(parseCsv(undefined)).toEqual([]);
    });

    it('should filter empty tokens', () => {
      expect(parseCsv('a,,b, ,c')).toEqual(['a', 'b', 'c']);
    });

    it('should trim whitespace', () => {
      expect(parseCsv('  foo , bar  ')).toEqual(['foo', 'bar']);
    });
  });

  // Date/time utilities

  describe('startOfToday', () => {
    it('should return midnight of current day', () => {
      const result = startOfToday();
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
    });

    it('should return a date for today', () => {
      const now = new Date();
      const result = startOfToday();
      expect(result.getFullYear()).toBe(now.getFullYear());
      expect(result.getMonth()).toBe(now.getMonth());
      expect(result.getDate()).toBe(now.getDate());
    });
  });

  describe('formatRelativeTime', () => {
    it('should handle ISO string input', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const result = formatRelativeTime(fiveMinAgo);
      expect(result).toBe('5m ago');
    });

    it('should handle epoch ms input', () => {
      const twoHoursAgo = Date.now() - 2 * 3600_000;
      const result = formatRelativeTime(twoHoursAgo);
      expect(result).toBe('2h ago');
    });

    it('should return "just now" for recent times', () => {
      const justNow = new Date().toISOString();
      const result = formatRelativeTime(justNow);
      expect(result).toBe('just now');
    });

    it('should handle days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
      const result = formatRelativeTime(threeDaysAgo);
      expect(result).toBe('3d ago');
    });
  });

  describe('formatClockTime', () => {
    it('should format time in 12-hour format from ISO string', () => {
      const result = formatClockTime('2024-12-08T14:30:00Z');
      // Should contain hours and minutes
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should format time from epoch ms', () => {
      const result = formatClockTime(Date.now());
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should include AM/PM indicator', () => {
      const amResult = formatClockTime('2024-12-08T09:15:00Z');
      const pmResult = formatClockTime('2024-12-08T14:30:00Z');
      expect(amResult + pmResult).toMatch(/[AaPp][Mm]/);
    });

    it('writes the hour without a leading zero', () => {
      expect(formatClockTime(new Date(2024, 11, 8, 20, 33))).toMatch(/^8:33\sPM$/);
      expect(formatClockTime(new Date(2024, 11, 8, 9, 5))).toMatch(/^9:05\sAM$/);
    });
  });

  describe('formatClockTime24', () => {
    it('should format time in 24-hour format', () => {
      const result = formatClockTime24('2024-12-08T14:30:00Z');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe('formatClockTimeWithSeconds', () => {
    it('should include seconds', () => {
      const result = formatClockTimeWithSeconds('2024-12-08T14:30:45Z');
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });
  });

  describe('formatLongDate', () => {
    it('should return a human-readable date string', () => {
      const date = new Date('2024-12-08T14:30:00Z');
      const result = formatLongDate(date);
      // Should contain month name and day
      expect(result).toMatch(/Dec|December/);
      expect(result).toMatch(/8/);
    });

    it('should accept string input', () => {
      const result = formatLongDate('2024-12-08T14:30:00Z');
      expect(result).toMatch(/Dec|December/);
    });

    it('should accept epoch ms input', () => {
      const result = formatLongDate(Date.now());
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('sleep', () => {
    it('should resolve after the specified delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // allow 10ms jitter
    });

    it('should resolve with undefined', async () => {
      const result = await sleep(1);
      expect(result).toBeUndefined();
    });
  });

  describe('parseIntervalToMs', () => {
    it('should parse seconds', () => {
      expect(parseIntervalToMs('5s')).toBe(5_000);
      expect(parseIntervalToMs('30s')).toBe(30_000);
    });

    it('should parse minutes', () => {
      expect(parseIntervalToMs('2m')).toBe(120_000);
      expect(parseIntervalToMs('10m')).toBe(600_000);
    });

    it('should parse hours', () => {
      expect(parseIntervalToMs('1h')).toBe(3_600_000);
      expect(parseIntervalToMs('24h')).toBe(86_400_000);
    });

    it('should parse days', () => {
      expect(parseIntervalToMs('1d')).toBe(86_400_000);
      expect(parseIntervalToMs('7d')).toBe(604_800_000);
    });

    it('should return 0 for unrecognized patterns', () => {
      expect(parseIntervalToMs('1000')).toBe(0);
      expect(parseIntervalToMs('abc')).toBe(0);
      expect(parseIntervalToMs('')).toBe(0);
    });
  });
});
