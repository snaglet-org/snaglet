/**
 * PATCH /api/settings/:category/:key over the real settings service, with the
 * settings rows in memory: the color theme refuses names that are not tokens
 * (400, nothing written), a null resets a token by removing it, a reset
 * reaches a theme saved under old token names, and a setting that did not opt
 * in (budget) still stores null as given.
 */
import { beforeEach, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockRows = new Map<string, unknown>();

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: async (category: string, key: string) =>
      mockRows.has(`${category}.${key}`)
        ? { category, key, value: mockRows.get(`${category}.${key}`) }
        : null,
  },
}));
// INSERT … ON CONFLICT DO NOTHING, SELECT … FOR UPDATE, UPDATE — answered from mockRows.
jest.mock('@snaglet/db', () => ({
  transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      query: async (sql: string, params: unknown[]) => {
        const [category, key, json] = params as string[];
        const id = `${category}.${key}`;
        if (sql.includes('INSERT')) {
          if (!mockRows.has(id)) mockRows.set(id, JSON.parse(json!));
        } else if (sql.includes('FOR UPDATE')) {
          return { rows: mockRows.has(id) ? [{ value: structuredClone(mockRows.get(id)) }] : [] };
        } else if (sql.includes('UPDATE')) {
          mockRows.set(id, JSON.parse(json!));
        }
        return { rows: [] };
      },
    }),
}));

import settingsRoutes from '@server/routes/settings';
import { errorHandler } from '@server/middleware/errorHandler';
import { settingsService } from '@server/services/settings';
import { workspaceColorResetPatch } from '@snaglet/shared/constants/workspaceTheme';

const app = express().use(express.json()).use('/settings', settingsRoutes).use(errorHandler);
const patchColors = (value: unknown) =>
  request(app).patch('/settings/appearance/colors').send({ value });

beforeEach(() => {
  mockRows.clear();
  settingsService.invalidate();
});

it('refuses a theme field that is not a token, writing nothing', async () => {
  mockRows.set('appearance.colors', { detail: '#00aa88' });
  for (const value of [{ nope: null }, { nope: '#123456' }, { canvas: '#111111' }]) {
    const response = await patchColors(value);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/Unknown entry for appearance\.colors/);
  }
  expect(mockRows.get('appearance.colors')).toEqual({ detail: '#00aa88' });
});

it('resets a token by removing it from the saved theme', async () => {
  mockRows.set('appearance.colors', { detail: '#00aa88', sidebar: '#eeeeee' });
  const response = await patchColors({ detail: null });
  expect(response.status).toBe(200);
  expect(mockRows.get('appearance.colors')).toEqual({ sidebar: '#eeeeee' });
});

it('resets a theme saved under old token names to an empty theme, and announces it', async () => {
  mockRows.set('appearance.colors', { panel: '#333333', bg: '#111111' });
  const seen: unknown[] = [];
  const off = settingsService.onChange((event) => seen.push(event));
  const response = await patchColors(workspaceColorResetPatch());
  off();
  expect(response.status).toBe(200);
  expect(mockRows.get('appearance.colors')).toEqual({});
  expect(seen).toHaveLength(1);
});

it('still stores null for a setting that did not opt in', async () => {
  const response = await request(app)
    .patch('/settings/budget/group')
    .send({ value: { maxWaves: null } });
  expect(response.status).toBe(200);
  expect(mockRows.get('budget.group')).toMatchObject({ maxWaves: null });
});
