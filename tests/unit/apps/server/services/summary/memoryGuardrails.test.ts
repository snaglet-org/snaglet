/** Fixed internal summary budgets and per-thread debounce behavior. */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsRead = jest.fn(async (definition: { key: string }): Promise<unknown> => {
  if (definition.key === 'thread_summary_model_overrides') return {};
  if (definition.key === 'summary_model_overrides') return {};
  if (definition.key === 'utility_model') {
    return { providerId: 'anthropic', modelId: 'legacy-workspace-model' };
  }
  if (definition.key === 'daily_summary_cap' || definition.key === 'backfill_daily_cap') return 1;
  return undefined;
});
const getEffectiveModel = jest.fn(async () => ({
  providerId: 'ollama',
  modelId: 'agent-owned-model',
  credentialId: null,
}));
const findByProviderAndModelId = jest.fn(async (): Promise<unknown> => null);
const warn = jest.fn();

jest.mock('@server/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('@server/services/settings', () => ({
  settingsService: {
    read: (...args: unknown[]) => settingsRead(...(args as [{ key: string }])),
  },
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    getEffectiveModel: (...args: unknown[]) => getEffectiveModel(...(args as [])),
  },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...(args as [])),
  },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecretById: jest.fn(async () => null),
    getSecret: jest.fn(async () => null),
  },
}));
jest.mock('@server/services/ProviderChatService/providers/registry', () => ({
  PROVIDER_REGISTRY: {
    ollama: { chat: jest.fn(), verify: jest.fn() },
  },
}));

import {
  checkMemoryGuardrails,
  getSummaryBudgetStatus,
  recordSummaryGeneration,
  resetMemoryGuardrailsForTests,
} from '@server/services/summary/memoryGuardrails';
import { resolveUtilityModel } from '@server/services/summary/UtilityModelResolver';

const T0 = new Date('2026-07-28T10:00:00Z');

function at(minutesLater: number): Date {
  return new Date(T0.getTime() + minutesLater * 60_000);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMemoryGuardrailsForTests();
  delete process.env.SNAGLET_SUMMARY_MIN_INTERVAL_MS;
  settingsRead.mockImplementation(async (definition: { key: string }) => {
    if (definition.key === 'thread_summary_model_overrides') return {};
    if (definition.key === 'summary_model_overrides') return {};
    if (definition.key === 'utility_model') {
      return { providerId: 'anthropic', modelId: 'legacy-workspace-model' };
    }
    if (definition.key === 'daily_summary_cap' || definition.key === 'backfill_daily_cap') return 1;
    return undefined;
  });
  getEffectiveModel.mockImplementation(async () => ({
    providerId: 'ollama',
    modelId: 'agent-owned-model',
    credentialId: null,
  }));
  findByProviderAndModelId.mockImplementation(async () => null);
});

describe('fixed automatic-generation cap', () => {
  it('allows under the cap, blocks at the cap, logs once', async () => {
    for (let index = 0; index < 199; index += 1) {
      recordSummaryGeneration(`thread-${index}`, 'agent-1', T0);
    }
    expect(await checkMemoryGuardrails('thread-199', 'agent-1', at(5))).toBeNull();
    recordSummaryGeneration('thread-199', 'agent-1', T0);

    const blocked = await checkMemoryGuardrails('thread-200', 'agent-1', at(5));
    expect(blocked).toMatchObject({
      reason: 'daily-cap-reached',
      detail: '200/200 generations today',
    });

    await checkMemoryGuardrails('thread-201', 'agent-1', at(6));
    expect(warn).toHaveBeenCalledTimes(1); // once per day, not per attempt
  });

  it('resets on the next UTC day', async () => {
    for (let index = 0; index < 200; index += 1) {
      recordSummaryGeneration(`thread-${index}`, 'agent-1', T0);
    }
    expect(await checkMemoryGuardrails('t1', 'a1', at(10))).toMatchObject({
      reason: 'daily-cap-reached',
    });

    const nextDay = new Date('2026-07-29T00:01:00Z');
    expect(await checkMemoryGuardrails('t1', 'a1', nextDay)).toBeNull();
  });

  it('reports budget status (incl. the backfill lane)', async () => {
    recordSummaryGeneration('t1', 'a1', T0);
    expect(await getSummaryBudgetStatus(at(1))).toEqual({
      usedToday: 1,
      dailyCap: 200,
      backfillUsedToday: 0,
      backfillDailyCap: 50,
    });
  });
});

describe('removed workspace Memory settings', () => {
  it('cannot select a provider/model or change the fixed caps', async () => {
    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: 'thread-1',
      agentId: 'agent-1',
    });

    expect(resolution).toMatchObject({
      ok: true,
      model: {
        providerId: 'ollama',
        modelId: 'agent-owned-model',
        source: 'own-model',
      },
    });
    // All three are agent-scoped. The third names no model and no provider —
    // it only decides whether step 3 (the agent's own model) may run at all —
    // so it cannot smuggle a workspace-wide summarizer back in.
    expect(settingsRead.mock.calls.map(([definition]) => definition.key)).toEqual([
      'thread_summary_model_overrides',
      'summary_model_overrides',
      'summary_model_require_explicit',
    ]);
    expect(await getSummaryBudgetStatus(T0)).toMatchObject({
      dailyCap: 200,
      backfillDailyCap: 50,
    });
  });
});

describe('per-thread debounce', () => {
  it('blocks a second automatic pass inside the interval, allows after', async () => {
    recordSummaryGeneration('t1', 'a1', T0);

    const blocked = await checkMemoryGuardrails('t1', 'a1', at(1)); // default 120s
    expect(blocked).toMatchObject({ reason: 'debounced' });

    // A different thread is unaffected.
    expect(await checkMemoryGuardrails('t2', 'a1', at(1))).toBeNull();

    // After the interval, allowed again.
    expect(await checkMemoryGuardrails('t1', 'a1', at(3))).toBeNull();
  });

  it('honors SNAGLET_SUMMARY_MIN_INTERVAL_MS', async () => {
    process.env.SNAGLET_SUMMARY_MIN_INTERVAL_MS = '0';
    recordSummaryGeneration('t1', 'a1', T0);
    expect(await checkMemoryGuardrails('t1', 'a1', T0)).toBeNull();
  });
});
