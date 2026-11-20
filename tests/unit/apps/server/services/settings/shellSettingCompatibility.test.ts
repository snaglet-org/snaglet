import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { safeJsonParse } from '@snaglet/shared/utils';

const rows = new Map<string, unknown>();
const write = jest.fn(async (category: string, key: string, value: unknown) => {
  rows.set(`${category}.${key}`, value);
});
const remove = jest.fn(async (category: string, key: string) => {
  rows.delete(`${category}.${key}`);
});
jest.mock('@snaglet/db', () => ({
  transaction: async (
    run: (tx: {
      query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ value: unknown }> }>;
    }) => Promise<unknown>
  ) =>
    run({
      query: async (sql: string, params: unknown[]) => {
        const key = `${params[0]}.${params[1]}`;
        if (sql.includes('INSERT') && !rows.has(key))
          rows.set(key, safeJsonParse<unknown>(String(params[2]), null));
        if (sql.trimStart().startsWith('UPDATE'))
          rows.set(key, safeJsonParse<unknown>(String(params[2]), null));
        return { rows: sql.includes('SELECT') && rows.has(key) ? [{ value: rows.get(key) }] : [] };
      },
    }),
}));

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: jest.fn(async (category: string, key: string) => {
      const value = rows.get(`${category}.${key}`);
      return value === undefined ? null : { category, key, value };
    }),
    listByCategory: jest.fn(async (category: string) =>
      [...rows]
        .filter(([key]) => key.startsWith(`${category}.`))
        .map(([key, value]) => ({
          category,
          key: key.slice(category.length + 1),
          value,
        }))
    ),
    listAll: jest.fn(async () =>
      [...rows].map(([name, value]) => {
        const [category, key] = name.split('.');
        return {
          category,
          key,
          value,
          updatedAt: '2026-01-01T00:00:00Z',
          updatedByUserId: null,
          updatedByAgentId: null,
        };
      })
    ),
    write,
    remove,
  },
}));

import { settingsService, selectSettingOverride } from '@server/services/settings/settingsService';
import { toolSettings } from '@server/services/settings/categories/tool';
import { cache } from '@server/services/settings/cache';
import { registry } from '@server/services/settings/registry';

import express from 'express';
import request from 'supertest';
import settingsRouter from '@server/routes/settings';

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);
const def = toolSettings.shell;

beforeEach(() => {
  rows.clear();
  cache.__clearForTests();
  jest.clearAllMocks();
});

describe('canonical shell setting compatibility', () => {
  it.each([
    ['old-only', { timeoutMs: 1000 }, undefined, { timeoutMs: 1000 }],
    ['new-only', undefined, { maxBufferKb: 1 }, { maxBufferKb: 1 }],
    ['both-set', { timeoutMs: 1000 }, { maxBufferKb: 1 }, { maxBufferKb: 1 }],
    ['empty new wins', { timeoutMs: 1000 }, {}, {}],
  ])(
    '%s resolves consistently for execution, category and registry UI',
    async (_name, old, current, expected) => {
      if (old !== undefined) rows.set('tool.shell_exec', old);
      if (current !== undefined) rows.set('tool.shell', current);
      expect(await settingsService.read(def)).toEqual(expected);
      expect(await settingsService.readOptional(def)).toEqual(expected);
      const category = await settingsService.readCategory('tool');
      expect(category.shell).toEqual(expected);
      expect(category).not.toHaveProperty('shell_exec');
      expect(
        selectSettingOverride(def, new Map([...rows].map(([key, value]) => [key.slice(5), value])))
      ).toEqual(expected);
    }
  );

  it('registry HTTP response presents an old override under the new key and PUT saves there', async () => {
    rows.set('tool.shell_exec', { timeoutMs: 1000, maxBufferKb: 2 });
    const response = await request(app).get('/api/settings/registry').expect(200);
    const records = response.body.data as Array<{
      category: string;
      key: string;
      current: unknown;
      isOverridden: boolean;
      updatedAt: string;
    }>;
    const record = records.find((row) => row.category === 'tool' && row.key === 'shell');
    expect(record).toMatchObject({
      current: { timeoutMs: 1000, maxBufferKb: 2 },
      isOverridden: true,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(records.some((row) => row.category === 'tool' && row.key === 'shell_exec')).toBe(false);
    await request(app)
      .patch('/api/settings/tool/shell')
      .send({ value: { maxBufferKb: 3 } })
      .expect(200);
    expect(rows.get('tool.shell')).toEqual({ timeoutMs: 1000, maxBufferKb: 3 });
    await request(app).put('/api/settings/tool/shell').send({ value: {} }).expect(200);
    expect(rows.get('tool.shell')).toEqual({});
    await request(app).delete('/api/settings/tool/shell').expect(200);
    expect(rows.has('tool.shell_exec')).toBe(false);
    expect(rows.has('tool.shell')).toBe(false);
  });

  it('has only the canonical registry key and preserves unset semantics', async () => {
    expect(registry.get('tool', 'shell')).toBe(def);
    expect(registry.get('tool', 'shell_exec')).toBeUndefined();
    expect(await settingsService.readOptional(def)).toBeNull();
    expect(await settingsService.read(def)).toEqual(def.default);
  });

  it('saves to the new key and invalidates cached fallback values', async () => {
    rows.set('tool.shell_exec', { timeoutMs: 1000 });
    await settingsService.read(def);
    await settingsService.readCategory('tool');
    await settingsService.write(def, { maxBufferKb: 2 });
    expect(write).toHaveBeenCalledWith('tool', 'shell', { maxBufferKb: 2 }, {});
    expect(await settingsService.read(def)).toEqual({ maxBufferKb: 2 });
    expect((await settingsService.readCategory('tool')).shell).toEqual({ maxBufferKb: 2 });
  });

  it('entry writes carry old fields over into the canonical row', async () => {
    rows.set('tool.shell_exec', { timeoutMs: 1000, maxBufferKb: 2 });
    await settingsService.writeEntry(def, ['maxBufferKb'], 3);
    expect(rows.get('tool.shell')).toEqual({ timeoutMs: 1000, maxBufferKb: 3 });
    expect(await settingsService.readOptional(def)).toEqual({ timeoutMs: 1000, maxBufferKb: 3 });
  });

  it('entry removals carry the remaining old fields into the canonical row', async () => {
    rows.set('tool.shell_exec', { timeoutMs: 1000, maxBufferKb: 2 });
    await settingsService.removeEntry(def, ['maxBufferKb']);
    expect(rows.get('tool.shell')).toEqual({ timeoutMs: 1000 });
  });

  it('reverting clears both keys instead of resurrecting the fallback', async () => {
    rows.set('tool.shell_exec', { timeoutMs: 1000 });
    rows.set('tool.shell', { maxBufferKb: 2 });
    await settingsService.revert(def);
    expect(remove).toHaveBeenCalledWith('tool', 'shell_exec');
    expect(remove).toHaveBeenCalledWith('tool', 'shell');
    expect(await settingsService.readOptional(def)).toBeNull();
  });

  it('validates old values and does not fall back from an invalid new value', async () => {
    rows.set('tool.shell_exec', { timeoutMs: -1 });
    await expect(settingsService.readOptional(def)).rejects.toThrow('fails schema');
    rows.set('tool.shell_exec', { timeoutMs: 1000 });
    rows.set('tool.shell', { maxBufferKb: -1 });
    await expect(settingsService.read(def)).rejects.toThrow('fails schema');
  });
});
