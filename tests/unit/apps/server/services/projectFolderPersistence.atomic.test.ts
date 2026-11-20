import type { DbClient } from '@snaglet/db/adapters';

const mockTransaction = jest.fn();
const mockQuery = jest.fn();
const mockTouch = jest.fn();
jest.mock('@snaglet/db/db', () => ({
  transaction: mockTransaction,
  getDb: () => ({ query: mockQuery }),
}));
jest.mock('@snaglet/db/tables/nodes', () => ({ Nodes: { touch: mockTouch } }));
jest.mock('@snaglet/db/actorMember', () => ({ currentActorMemberId: async () => null }));
import { Projects } from '@snaglet/db/tables/projects';

it('acquires cross-process write exclusion before reads and updates, using only the transaction connection', async () => {
  const events: string[] = [];
  const txQuery = jest.fn(async (sql: string) => {
    events.push(sql);
    if (sql.includes('UPDATE')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const tx: DbClient = {
    query: txQuery,
    exec: jest.fn(),
    transaction: jest.fn(),
    end: jest.fn(),
  };
  mockTransaction.mockImplementation(async (fn: (runner: DbClient) => Promise<unknown>) => {
    events.push('BEGIN');
    const result = await fn(tx);
    events.push('COMMIT');
    return result;
  });
  await Projects.withFolderWriteLock(async (runner) => {
    await Projects.findById('test-project', runner);
    await Projects.listAll(runner);
    await Projects.update('test-project', { folderPath: '/test/manual' }, runner);
  });
  expect(events[0]).toBe('BEGIN');
  expect(events[1]).toBe('LOCK TABLE public.nodes, public.containers IN SHARE ROW EXCLUSIVE MODE');
  expect(events[events.length - 1]).toBe('COMMIT');
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockTouch).toHaveBeenCalledWith('test-project', tx);
  expect(mockTransaction).toHaveBeenCalledTimes(1);

  await Projects.update('test-project', { folderPath: '/test/new' });
  expect(mockTransaction).toHaveBeenCalledTimes(2);
  expect(mockQuery).not.toHaveBeenCalled();
});
