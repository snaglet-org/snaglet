/**
 * The agent row's revision (`updatedAt`) that a write reports must be the one
 * that write set, taken from the UPDATE itself. The row is read again after
 * the write, and another write can land in between: its revision would make
 * an open agent pane take this write's announcement for a change it already
 * holds, and skip it.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Agents } from '@snaglet/db/tables/agents';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };
const query = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

beforeEach(() => {
  query.mockReset();
  // Instance property over the prototype getter: the model's queries go here.
  Reflect.defineProperty(Agents, 'pool', { configurable: true, get: () => ({ query }) });
});

function answer(sql: string): QueryResult {
  if (sql.includes('information_schema')) return { rows: [] };
  if (sql.startsWith('UPDATE'))
    return { rows: [{ id: 'agent-1', updatedAt: 'rev-mine' }], rowCount: 1 };
  // The read-back sees a later write by someone else.
  return { rows: [{ id: 'agent-1', role: 'Theirs', updatedAt: 'rev-later' }] };
}

describe('Agents revision after a write', () => {
  it('update reports the revision its own UPDATE set', async () => {
    query.mockImplementation(async (sql) => answer(sql.trim()));

    const row = await Agents.update('agent-1', { role: 'Mine' });

    const update = query.mock.calls.find(([sql]) => sql.trim().startsWith('UPDATE'));
    expect(update?.[0]).toMatch(/RETURNING/);
    expect(row?.updatedAt).toBe('rev-mine');
  });

  it('update reports a missing agent as null', async () => {
    query.mockImplementation(async (sql) =>
      sql.trim().startsWith('UPDATE') ? { rows: [], rowCount: 0 } : answer(sql.trim())
    );
    expect(await Agents.update('missing', { role: 'Mine' })).toBeNull();
  });

  it('appendToolAccessAllowList reports the revision of its own append', async () => {
    query.mockImplementation(async (sql) => answer(sql.trim()));

    const appended = await Agents.appendToolAccessAllowList('agent-1', 'shell_exec');

    const append = query.mock.calls.find(([sql]) => sql.trim().startsWith('UPDATE'));
    expect(append?.[0]).toMatch(/RETURNING a\.id, a\.updated_at AS "updatedAt"/);
    expect(appended).toEqual({ id: 'agent-1', updatedAt: 'rev-mine' });
  });
});
