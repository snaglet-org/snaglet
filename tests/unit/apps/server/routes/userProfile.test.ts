import request from 'supertest';
import express from 'express';

// Shape thrown by the routes under test — read by the test error handler below.
interface TestAppError {
  httpStatus?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

const mockGetActiveUser = jest.fn();
const mockFindById = jest.fn();
const mockList = jest.fn();
const mockFindByName = jest.fn();
const mockCreateLocalUser = jest.fn();
const mockSetActiveUser = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@snaglet/db/tables/users', () => ({
  Users: {
    getActiveUser: (...args: unknown[]) => mockGetActiveUser(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    list: (...args: unknown[]) => mockList(...args),
    findByName: (...args: unknown[]) => mockFindByName(...args),
    createLocalUser: (...args: unknown[]) => mockCreateLocalUser(...args),
    setActiveUser: (...args: unknown[]) => mockSetActiveUser(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

import userProfileRouter from '@server/domains/user-profile/user-profile.routes';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local_user',
    name: 'Local User',
    email: 'local-user@snaglet.local',
    picture: null,
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('User profile routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/user-profile', userProfileRouter);
    app.use(
      (
        err: TestAppError,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
      }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveUser.mockResolvedValue(user());
    mockFindById.mockResolvedValue(user());
    mockList.mockResolvedValue([user()]);
    mockFindByName.mockResolvedValue(null);
    mockCreateLocalUser.mockResolvedValue(
      user({ id: 'test_user', name: 'Test User', active: false })
    );
    mockSetActiveUser.mockResolvedValue(user({ id: 'test_user', name: 'Test User', active: true }));
    mockUpdate.mockResolvedValue(user({ name: 'Updated' }));
  });

  it('creates an inactive local user by default without accepting caller identity fields', async () => {
    const res = await request(app).post('/api/user-profile/users').send({
      id: 'caller_supplied',
      authProvider: 'github',
      authProviderId: 'external',
      name: '  Test User  ',
      email: ' user@example.com ',
    });

    expect(res.status).toBe(200);
    expect(mockCreateLocalUser).toHaveBeenCalledWith({
      name: 'Test User',
      email: 'user@example.com',
      picture: undefined,
      makeActive: false,
    });
  });

  it('honors explicit make_active=true', async () => {
    const res = await request(app)
      .post('/api/user-profile/users')
      .send({ name: 'Test User', make_active: true });

    expect(res.status).toBe(200);
    expect(mockCreateLocalUser).toHaveBeenCalledWith({
      name: 'Test User',
      email: undefined,
      picture: undefined,
      makeActive: true,
    });
  });

  it('rejects duplicate names with 409 before writing', async () => {
    mockFindByName.mockResolvedValue(user({ id: 'test_user', name: 'Test User' }));

    const res = await request(app).post('/api/user-profile/users').send({ name: 'Test User' });

    expect(res.status).toBe(409);
    expect(mockCreateLocalUser).not.toHaveBeenCalled();
  });

  it('maps concurrent duplicate insert failures to 409', async () => {
    mockCreateLocalUser.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));

    const res = await request(app).post('/api/user-profile/users').send({ name: 'Test User' });

    expect(res.status).toBe(409);
  });

  it.each([
    [{ name: '' }, 400],
    [{ name: 'ghost' }, 400],
    [{ name: 'system' }, 400],
    [{ name: ' System ' }, 400],
    [{ name: 'Local User' }, 400],
    [{ name: 'Test User', email: 'not-email' }, 400],
    [{ name: 'Test User', make_active: 'yes' }, 400],
    [{ name: 'Test User', picture: 'file:///secret.png' }, 400],
  ])('validates create input %#', async (body, status) => {
    const res = await request(app).post('/api/user-profile/users').send(body);
    expect(res.status).toBe(status);
    expect(mockCreateLocalUser).not.toHaveBeenCalled();
  });

  it('switches active user through the server', async () => {
    const res = await request(app).post('/api/user-profile/active/test_user').send();

    expect(res.status).toBe(200);
    expect(mockSetActiveUser).toHaveBeenCalledWith('test_user');
    expect(res.body.data.active).toBe(true);
  });
  describe('PATCH /api/user-profile', () => {
    it('keeps the name the profile already has', async () => {
      mockFindByName.mockResolvedValue(user());
      const res = await request(app)
        .patch('/api/user-profile')
        .send({ name: 'Local User', email: 'user@example.com' });

      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith('local_user', {
        name: 'Local User',
        email: 'user@example.com',
      });
    });

    it.each([[''], ['   '], ['x'.repeat(81)]])(
      'rejects the name %j without writing',
      async (name) => {
        const res = await request(app).patch('/api/user-profile').send({ name });

        expect(res.status).toBe(400);
        expect(mockUpdate).not.toHaveBeenCalled();
      }
    );

    it("rejects another user's name with 409 without writing", async () => {
      mockFindByName.mockResolvedValue(user({ id: 'test_user', name: 'Test User' }));
      const res = await request(app).patch('/api/user-profile').send({ name: 'test user' });

      expect(res.status).toBe(409);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
