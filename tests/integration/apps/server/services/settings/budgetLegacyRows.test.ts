/**
 * Budget settings rows that still carry `perAgentTokenBudget` load: the
 * budget schemas strip unknown keys instead of rejecting the row (a
 * rejected row would make `settingsService.read` throw and break every chat
 * dispatch). A saved 32,000 pool is kept as the user's explicit choice.
 */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Settings } from '@snaglet/db/tables/settings';
import { settingsService } from '@server/services/settings/settingsService';
import { budgetSettings } from '@server/services/settings/categories/budget';
import { cache } from '@server/services/settings/cache';

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.settings WHERE category = 'budget'`);
  cache.invalidate('budget', 'group');
  cache.invalidate('budget', 'solo');
}

describe('budget settings rows saved with the removed per-agent budget', () => {
  afterAll(cleanup);
  beforeEach(cleanup);

  it('loads a legacy group row, dropping perAgentTokenBudget', async () => {
    await Settings.write('budget', 'group', {
      conversationTokenBudget: 32_000,
      perAgentTokenBudget: 8_000,
      maxWaves: 24,
      streamThinking: true,
    });

    await expect(settingsService.read(budgetSettings.group)).resolves.toEqual({
      conversationTokenBudget: 32_000,
      maxWaves: 24,
      streamThinking: true,
    });
  });

  it('loads a legacy solo row, dropping perAgentTokenBudget', async () => {
    await Settings.write('budget', 'solo', {
      conversationTokenBudget: 32_000,
      perAgentTokenBudget: 16_000,
      maxWaves: 24,
    });

    await expect(settingsService.read(budgetSettings.solo)).resolves.toEqual({
      conversationTokenBudget: 32_000,
      maxWaves: 24,
    });
  });

  it('keeps accepting a legacy value on write, storing it without the removed key', async () => {
    await settingsService.write(budgetSettings.solo, {
      conversationTokenBudget: 32_000,
      perAgentTokenBudget: 16_000,
      maxWaves: 12,
    } as never);

    const row = await Settings.read('budget', 'solo');
    expect(row?.value).toEqual({ conversationTokenBudget: 32_000, maxWaves: 12 });
  });

  it('falls back to the ceiling-sized defaults when nothing is saved', async () => {
    const group = await settingsService.read(budgetSettings.group);
    const solo = await settingsService.read(budgetSettings.solo);
    expect(group.conversationTokenBudget).toBe(192_000);
    expect(solo.conversationTokenBudget).toBe(192_000);
  });
});
