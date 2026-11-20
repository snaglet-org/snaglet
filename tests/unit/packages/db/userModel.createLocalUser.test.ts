const mockTransaction = jest.fn();

jest.mock('@snaglet/db/db', () => ({
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('@snaglet/db/tables/members', () => ({
  Members: { ensureForUser: jest.fn() },
}));

import { Users } from '@snaglet/db/tables/users';

function makeTx(queryImpl: jest.Mock) {
  return {
    query: queryImpl,
    exec: jest.fn(),
    transaction: jest.fn(),
    end: jest.fn(),
  };
}

describe('UserModel.createLocalUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Reflect.set(Users, 'activeColumnPromise', Promise.resolve(true));
  });

  it('creates a local user and member bridge inside one transaction without changing active by default', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'test_user',
            email: 'user@example.com',
            name: 'Test User',
            picture: null,
            active: false,
            auth_provider: 'local',
            auth_provider_id: 'test_user',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const tx = makeTx(query);
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    const row = await Users.createLocalUser({
      name: ' Test User ',
      email: 'user@example.com',
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      id: 'test_user',
      name: 'Test User',
      email: 'user@example.com',
      active: false,
      authProvider: 'local',
      authProviderId: 'test_user',
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('active = false'),
      expect.anything()
    );
    expect(query.mock.calls[2][0]).toContain('INSERT INTO public.users');
    expect(query.mock.calls[2][1]).toEqual([
      'test_user',
      'user@example.com',
      'Test User',
      null,
      false,
      'local',
      'test_user',
    ]);
    expect(query.mock.calls[3][0]).toContain('INSERT INTO public.members');
  });

  it('atomically clears active users before inserting when makeActive=true', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'test_user',
            email: 'test_user@snaglet.local',
            name: 'Test User',
            picture: null,
            active: true,
            auth_provider: 'local',
            auth_provider_id: 'test_user',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const tx = makeTx(query);
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    const row = await Users.createLocalUser({ name: 'Test User', makeActive: true });

    expect(row.active).toBe(true);
    expect(query.mock.calls[2][0]).toContain('UPDATE public.users SET active = false');
    expect(query.mock.calls[3][1]).toEqual([
      'test_user',
      'test_user@snaglet.local',
      'Test User',
      null,
      true,
      'local',
      'test_user',
    ]);
  });

  it('throws before inserting if the name or computed id already exists', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 'test_user' }], rowCount: 1 });
    const tx = makeTx(query);
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    await expect(Users.createLocalUser({ name: 'Test User' })).rejects.toMatchObject({
      code: 'USER_DUPLICATE_NAME',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('LOWER(name)');
  });

  it('lets transaction rollback user insertion if member bridge creation fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'test_user',
            email: 'test_user@snaglet.local',
            name: 'Test User',
            picture: null,
            active: false,
            auth_provider: 'local',
            auth_provider_id: 'test_user',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error('member bridge failed'));
    const tx = makeTx(query);
    mockTransaction.mockImplementation(async (fn) => fn(tx));

    await expect(Users.createLocalUser({ name: 'Test User' })).rejects.toThrow(
      'member bridge failed'
    );

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[2][0]).toContain('INSERT INTO public.users');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO public.members');
  });
});
