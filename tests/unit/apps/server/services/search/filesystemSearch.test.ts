/**
 * Unit tests for the palette filesystem search service.
 *
 * Covers the fuzzyScore ranking bands (exact > prefix > substring >
 * subsequence > no match) and the searchProjectFilesystem early-exit
 * contract: no threadId or an empty query yields [] without touching
 * the filesystem.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const dbQuery = jest.fn();

jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (...args: unknown[]) => dbQuery(...args) }),
}));

import { fuzzyScore, searchProjectFilesystem } from '@server/services/search/filesystemSearch';

describe('fuzzyScore', () => {
  it('ranks exact > prefix > substring > subsequence > no match', () => {
    const exact = fuzzyScore('index', 'index');
    const prefix = fuzzyScore('indexing', 'index');
    const substring = fuzzyScore('reindex', 'index');
    const subsequence = fuzzyScore('insta-doc-ex', 'index');
    const none = fuzzyScore('readme', 'index');

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(none);
    expect(none).toBe(0);
  });

  it('normalizes case and non-alphanumerics before comparing', () => {
    expect(fuzzyScore('My_File.TS', 'myfilets')).toBe(fuzzyScore('myfilets', 'myfilets'));
  });

  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
    expect(fuzzyScore('anything', '--')).toBe(0);
  });

  it('prefers earlier substring matches', () => {
    expect(fuzzyScore('index-utils', 'dex')).toBeGreaterThan(fuzzyScore('appendix-dex', 'dex'));
  });
});

describe('searchProjectFilesystem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns [] without querying the db when threadId is undefined', async () => {
    const results = await searchProjectFilesystem(undefined, 'index', null);

    expect(results).toEqual([]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns [] when the thread has no project folder', async () => {
    dbQuery.mockResolvedValue({ rows: [] });

    const results = await searchProjectFilesystem('thread-1', 'index', null);

    expect(results).toEqual([]);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it('returns [] for an empty query even when a project folder exists', async () => {
    dbQuery.mockResolvedValue({
      rows: [{ project_id: 'proj-1', folder_path: '/tmp/proj-1' }],
    });

    const results = await searchProjectFilesystem('thread-1', '', null);

    expect(results).toEqual([]);
  });
});
