import { describe, expect, it, vi, afterEach } from 'vitest';
import { browserProfilesApi, formatLastUsed, parseProfiles } from './browserProfilesApi';

afterEach(() => vi.unstubAllGlobals());

describe('parseProfiles', () => {
  it('accepts a bare array and an envelope, dropping malformed rows', () => {
    const row = { id: 'main', name: 'Main', exists: true, running: true, lastUsedAt: null };
    expect(parseProfiles([row, null, { name: 'x' }])).toEqual([row]);
    expect(parseProfiles({ success: true, data: [row] })).toEqual([row]);
    expect(parseProfiles('nope')).toEqual([]);
  });
  it('defaults name to id and running to false', () => {
    expect(parseProfiles([{ id: 'work' }])[0]).toMatchObject({ name: 'work', running: false });
  });
});

describe('formatLastUsed', () => {
  it('handles null and invalid', () => {
    expect(formatLastUsed(null)).toBe('Never used');
    expect(formatLastUsed('garbage')).toBe('Never used');
    expect(formatLastUsed(1700000000000)).toMatch(/^Last used /);
  });
});

describe('browserProfilesApi.list', () => {
  it('treats a 404 as no profiles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nf', { status: 404 })));
    await expect(browserProfilesApi.list()).resolves.toEqual([]);
  });
  it('rethrows other errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    );
    await expect(browserProfilesApi.list()).rejects.toThrow('boom');
  });
});
