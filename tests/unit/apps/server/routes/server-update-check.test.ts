const mockStatus = jest.fn();
const mockCheckFromUser = jest.fn();
const mockCheckNow = jest.fn();
jest.mock('@server/services/UpdateCheckService', () => ({
  updateCheckService: {
    status: (...args: unknown[]) => mockStatus(...args),
    checkFromUser: (...args: unknown[]) => mockCheckFromUser(...args),
    checkNow: (...args: unknown[]) => mockCheckNow(...args),
  },
}));

import express from 'express';
import request from 'supertest';
import serverRoutes from '@server/routes/server';

const status = {
  currentVersion: '1.0.0',
  lastCheckedAt: '2026-11-20T10:00:00.000Z',
  latest: null,
  updateAvailable: false,
  lastError: 'GitHub answered with status 502.',
};

describe('update check routes', () => {
  const app = express().use('/api/server', serverRoutes);

  beforeEach(() => {
    mockStatus.mockReset().mockResolvedValue(status);
    mockCheckFromUser.mockReset().mockResolvedValue(status);
    mockCheckNow.mockReset();
  });

  it('reports the cached status, including why the last check failed', async () => {
    const res = await request(app).get('/api/server/update-status').expect(200);
    expect(res.body).toEqual(status);
    expect(mockCheckFromUser).not.toHaveBeenCalled();
  });

  it('checks now through the rate-limited path a person uses', async () => {
    const res = await request(app).post('/api/server/update-check').expect(200);
    expect(res.body).toEqual(status);
    expect(mockCheckFromUser).toHaveBeenCalledTimes(1);
    // The unspaced check stays for the daily schedule only.
    expect(mockCheckNow).not.toHaveBeenCalled();
  });
});
