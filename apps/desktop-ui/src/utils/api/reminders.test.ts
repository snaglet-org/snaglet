import { afterEach, describe, expect, it, vi } from 'vitest';
import { reminderItemQuery, remindersApi } from './reminders';

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('remindersApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names each kind of item in the query', () => {
    expect(reminderItemQuery({ kind: 'event', eventId: 'event-1' })).toBe(
      'kind=event&eventId=event-1'
    );
    expect(
      reminderItemQuery({ kind: 'table_entry', tableId: 't 1', entryId: 'e1', fieldId: 'f1' })
    ).toBe('kind=table_entry&tableId=t+1&entryId=e1&fieldId=f1');
    expect(reminderItemQuery({ kind: 'automation', automationId: 'a1' })).toBe(
      'kind=automation&automationId=a1'
    );
  });

  it('reads, writes and deletes settings, and lists upcoming reminders', async () => {
    const fetchMock = vi.fn(async () => ok({ settings: null }));
    vi.stubGlobal('fetch', fetchMock);
    const item = { kind: 'event' as const, eventId: 'event-1' };
    const body = { enabled: true, atStart: true, offsets: [], sound: 'chime' as const };

    await expect(remindersApi.getSettings(item)).resolves.toEqual({ settings: null });
    await remindersApi.updateSettings(item, body);
    await remindersApi.deleteSettings(item);
    await remindersApi.upcoming(72);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls.map(([url, init]) => [init?.method ?? 'GET', url])).toEqual([
      ['GET', '/api/reminders/settings?kind=event&eventId=event-1'],
      ['PUT', '/api/reminders/settings?kind=event&eventId=event-1'],
      ['DELETE', '/api/reminders/settings?kind=event&eventId=event-1'],
      ['GET', '/api/reminders/upcoming?hours=72'],
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual(body);
  });
});
