/**
 * UtilityModelResolver — the privacy-first resolution chain for per-agent
 * thread summaries, across the provider matrix. Every DB / credential /
 * settings boundary is mocked; these tests are about which model the chain
 * picks and which providers it never even considers.
 *
 * The chain is three steps and then a visible skip:
 *
 *   1. thread-agent override (`agent.thread_summary_model_overrides`)
 *   2. agent override        (`agent.summary_model_overrides`)
 *   3. the agent's effective model for that thread (the default)
 *   4. skip, with an enumerated reason
 *
 * There is deliberately no workspace-wide override and no automatic
 * local-provider fallback: either would send content to a provider the agent
 * is not on, which no type error would catch. An agent on ollama with
 * anthropic credentials present and no explicit config resolves to its own
 * ollama model, never touching another cloud provider's credentials.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findByProviderAndModelId = jest.fn(async (): Promise<unknown> => null);
const getEffectiveModel = jest.fn(async (): Promise<unknown> => null);
const getSecretById = jest.fn(async (): Promise<string | null> => null);
const getSafeById = jest.fn(async (): Promise<{ id: string; providerId: string } | null> => null);
const getSecret = jest.fn(async (_providerId: string): Promise<string | null> => null);
const resolveCredentialIdForModel = jest.fn(async (): Promise<string | null> => null);
const settingsRead = jest.fn(async (def: { key: string }): Promise<unknown> => {
  if (def.key === 'thread_summary_model_overrides') return settingsState.threadOverrides;
  if (def.key === 'summary_model_overrides') return settingsState.agentOverrides;
  if (def.key === 'summary_model_require_explicit') return settingsState.requireExplicit;
  return undefined;
});

const settingsState: {
  threadOverrides: Record<
    string,
    Record<string, { providerId: string; modelId: string; credentialId?: string | null }>
  >;
  agentOverrides: Record<
    string,
    { providerId: string; modelId: string; credentialId?: string | null }
  >;
  requireExplicit: boolean;
} = { threadOverrides: {}, agentOverrides: {}, requireExplicit: false };

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...(args as [])),
  },
}));

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { getEffectiveModel: (...args: unknown[]) => getEffectiveModel(...(args as [])) },
}));

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecretById: (...args: unknown[]) => getSecretById(...(args as [])),
    getSafeById: (...args: unknown[]) => getSafeById(...(args as [])),
    getSecret: (...args: unknown[]) => getSecret(...(args as [string])),
    resolveCredentialIdForModel: (...args: unknown[]) =>
      resolveCredentialIdForModel(...(args as [])),
  },
}));

jest.mock('@server/services/ProviderChatService/providers/registry', () => ({
  PROVIDER_REGISTRY: {
    anthropic: { chat: jest.fn(), verify: jest.fn() },
    openai: { chat: jest.fn(), verify: jest.fn(), envSecretVars: ['OPENAI_API_KEY_TEST_ONLY'] },
    google: { chat: jest.fn(), verify: jest.fn() },
    mistral: { chat: jest.fn(), verify: jest.fn() },
    ollama: { chat: jest.fn(), verify: jest.fn() },
    'lm-studio': { chat: jest.fn(), verify: jest.fn() },
    'apple-on-device': { chat: jest.fn(), verify: jest.fn() },
    github: { verify: jest.fn() }, // verify-only — never summary-capable
  },
}));

jest.mock('@server/services/ProviderChatService/shared', () => ({
  normalizeProviderId: (raw: string) => {
    const p = (raw || '').toLowerCase().trim();
    if (p === 'gemini') return 'google';
    return p;
  },
}));

jest.mock('@server/services/settings', () => ({
  settingsService: { read: (...args: unknown[]) => settingsRead(...(args as [{ key: string }])) },
}));

import { resolveUtilityModel } from '@server/services/summary/UtilityModelResolver';
import { CredentialDecryptError } from '@server/services/ProviderCredentialService/errors';

const THREAD = 'thread-1';
const AGENT = 'agent-1';

/** Resolve for the only purpose this resolver serves. */
const resolve = (over: { threadId?: string; agentId?: string } = {}) =>
  resolveUtilityModel({
    purpose: 'thread-summary',
    threadId: THREAD,
    agentId: AGENT,
    ...over,
  });

/** Mark a cloud model active in the catalog so explicit refs validate. */
function catalogActive(): void {
  findByProviderAndModelId.mockResolvedValue({ isActive: true, contextWindowTokens: 200_000 });
}

function usableCredential(id: string, providerId: string): void {
  getSafeById.mockResolvedValue({ id, providerId });
  getSecretById.mockResolvedValue('selected-secret');
}

beforeEach(() => {
  jest.clearAllMocks();
  settingsState.threadOverrides = {};
  settingsState.agentOverrides = {};
  settingsState.requireExplicit = false;
  findByProviderAndModelId.mockResolvedValue(null);
  getEffectiveModel.mockResolvedValue(null);
  getSecretById.mockResolvedValue(null);
  getSafeById.mockResolvedValue(null);
  getSecret.mockResolvedValue(null);
  resolveCredentialIdForModel.mockResolvedValue(null);
});

describe('UtilityModelResolver — chain order', () => {
  it('step 1: a thread-agent override wins over everything below it', async () => {
    catalogActive();
    usableCredential('cred-thread', 'anthropic');
    settingsState.threadOverrides = {
      [THREAD]: {
        [AGENT]: {
          providerId: 'anthropic',
          modelId: 'claude-haiku-4-5',
          credentialId: 'cred-thread',
        },
      },
    };
    settingsState.agentOverrides = { [AGENT]: { providerId: 'openai', modelId: 'gpt-4o-mini' } };
    getEffectiveModel.mockResolvedValue({ providerId: 'google', modelId: 'gemini-2.0-flash' });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5',
        credentialId: 'cred-thread',
        source: 'thread-override',
      },
    });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('step 2: an agent override wins when no thread-agent override applies', async () => {
    catalogActive();
    usableCredential('cred-agent', 'openai');
    settingsState.agentOverrides = {
      [AGENT]: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-agent',
      },
    };
    getEffectiveModel.mockResolvedValue({ providerId: 'google', modelId: 'gemini-2.0-flash' });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-agent',
        source: 'agent-override',
      },
    });
  });

  it("a cloud override with no selected credential falls back to the same provider's default credential", async () => {
    catalogActive();
    getSecret.mockImplementation(async (providerId: string) =>
      providerId === 'openai' ? 'openai-default-secret' : null
    );
    settingsState.agentOverrides = {
      [AGENT]: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    };
    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: null,
        source: 'agent-override',
      },
    });
    // Same-provider only: the check asked openai's store, nothing else.
    expect(getSecret).toHaveBeenCalledWith('openai');
    expect(getSecret).not.toHaveBeenCalledWith('anthropic');
  });

  it('an unpinned summary credential resolves to the provider primary (same as the chat model), not most-recent', async () => {
    // An unpinned summary credential must resolve to the same key the chat
    // model (and the UI) uses: checkCredentials routes through
    // resolveCredentialIdForModel (preferred -> primary -> any) and pins its
    // id, rather than leaving the adapter to pick the most recently updated key.
    catalogActive();
    resolveCredentialIdForModel.mockResolvedValue('cred-primary');
    getSecretById.mockImplementation(async (id: string) =>
      id === 'cred-primary' ? 'primary-secret' : null
    );
    // A stale most-recent secret also exists in the store and must not be used.
    getSecret.mockResolvedValue('most-recent-secret');
    settingsState.agentOverrides = {
      [AGENT]: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    };

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-primary',
        source: 'agent-override',
      },
    });
    expect(resolveCredentialIdForModel).toHaveBeenCalledWith({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
  });

  it('fails a cloud override with no selected credential when the provider has no default credential either', async () => {
    catalogActive();
    getSecret.mockResolvedValue(null);
    settingsState.agentOverrides = {
      [AGENT]: { providerId: 'google', modelId: 'gemini-2.0-flash' },
    };
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
  });

  it('fails a mismatched selected credential instead of using another provider credential', async () => {
    catalogActive();
    getSafeById.mockResolvedValue({ id: 'cred-google', providerId: 'google' });
    getSecret.mockResolvedValue('wrong-fallback-secret');
    settingsState.agentOverrides = {
      [AGENT]: { providerId: 'openai', modelId: 'gpt-4o-mini', credentialId: 'cred-google' },
    };
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(getSecretById).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('does not fall through from a broken thread override to an agent override', async () => {
    catalogActive();
    settingsState.threadOverrides = {
      [THREAD]: {
        [AGENT]: {
          providerId: 'anthropic',
          modelId: 'claude-haiku-4-5',
          credentialId: 'missing-thread-cred',
        },
      },
    };
    usableCredential('cred-agent', 'openai');
    settingsState.agentOverrides = {
      [AGENT]: { providerId: 'openai', modelId: 'gpt-4o-mini', credentialId: 'cred-agent' },
    };
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
  });

  it("step 3: with nothing configured it uses the agent's own effective model", async () => {
    // The agent's model carries a working pinned credential — the ordinary case.
    usableCredential('cred-1', 'anthropic');
    getEffectiveModel.mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      credentialId: 'cred-1',
    });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        credentialId: 'cred-1',
        source: 'own-model',
      },
    });
  });

  it("a thread-agent override for a different agent does not leak into this agent's resolution", async () => {
    getSecret.mockResolvedValue('sk-test');
    settingsState.threadOverrides = {
      [THREAD]: { 'agent-other': { providerId: 'openai', modelId: 'gpt-4o-mini' } },
    };
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: { source: 'own-model', providerId: 'ollama' },
    });
  });
});

describe('UtilityModelResolver — the hard privacy rule', () => {
  it('an agent on ollama with anthropic credentials present resolves to ollama, never anthropic', async () => {
    // A stored secret exists for every cloud provider asked about.
    getSecret.mockResolvedValue('sk-anthropic-present');
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: { providerId: 'ollama', modelId: 'llama3.2:1b', source: 'own-model', isLocal: true },
    });
    // The resolver must not have gone looking for another cloud provider's key.
    for (const call of getSecret.mock.calls) {
      expect(call[0]).not.toBe('anthropic');
    }
  });

  it('never resolves to a cloud provider the agent is not on when its own model is unusable', async () => {
    // Agent is on anthropic but no credential resolves anywhere.
    getSecret.mockResolvedValue(null);
    getEffectiveModel.mockResolvedValue({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
  });
});

describe('UtilityModelResolver — removed tiers stay removed', () => {
  it('does not fall back to a local provider when the agent model is unusable — it skips visibly', async () => {
    // Every local runtime is installed and healthy; the resolver must still
    // refuse, because there is no automatic local fallback.
    getSecret.mockResolvedValue(null);
    getEffectiveModel.mockResolvedValue({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });

    const result = await resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-credentials');
  });

  it('never reads a global/workspace-wide utility-model setting', async () => {
    getSecret.mockResolvedValue('sk-test');
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    await resolve();

    const keysRead = settingsRead.mock.calls.map(([def]) => def.key);
    expect(keysRead).not.toContain('utility_model');
    // Every key read is agent-scoped. `summary_model_require_explicit` is a
    // policy toggle for whether step 3 may run at all — it names no model and
    // no provider, so it cannot reintroduce a workspace-wide summarizer.
    expect(new Set(keysRead)).toEqual(
      new Set([
        'thread_summary_model_overrides',
        'summary_model_overrides',
        'summary_model_require_explicit',
      ])
    );
  });

  it('reads both overrides from the agent-owned settings category, not a memory category', async () => {
    getSecret.mockResolvedValue('sk-test');
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    await resolve();

    for (const [def] of settingsRead.mock.calls) {
      expect((def as { category?: string }).category ?? 'agent').toBe('agent');
    }
  });
});

describe('UtilityModelResolver — visible skips', () => {
  it('skips with no-model-for-agent when the agent has no effective model', async () => {
    getEffectiveModel.mockResolvedValue(null);
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-model-for-agent' });
  });

  it('skips with no-model-for-agent when there is no agent to resolve for', async () => {
    const result = await resolve({ agentId: undefined });
    expect(result).toMatchObject({ ok: false, reason: 'no-model-for-agent' });
  });

  it('skips with unsupported-provider for a verify-only provider', async () => {
    getEffectiveModel.mockResolvedValue({ providerId: 'github', modelId: 'whatever' });
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'unsupported-provider' });
  });

  it('require-explicit: step 3 is skipped rather than borrowing the agent model', async () => {
    settingsState.requireExplicit = true;
    getSecret.mockResolvedValue('sk-test');
    getEffectiveModel.mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      credentialId: 'cred-1',
    });

    const result = await resolve();
    // Skipped, not substituted with something cheaper or local: the caller
    // stops the run on this, and no other model is ever consulted.
    expect(result).toMatchObject({ ok: false, reason: 'no-summary-model-configured' });
    expect(getEffectiveModel).not.toHaveBeenCalled();
  });

  it('require-explicit: an explicit override still resolves normally', async () => {
    settingsState.requireExplicit = true;
    catalogActive();
    usableCredential('cred-explicit', 'openai');
    settingsState.agentOverrides = {
      [AGENT]: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-explicit',
      },
    };

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-explicit',
        source: 'agent-override',
      },
    });
  });

  it('never throws — an unexpected failure becomes a visible resolution-failed skip', async () => {
    getEffectiveModel.mockRejectedValue(new Error('database is on fire'));
    settingsRead.mockImplementationOnce(async () => {
      throw new Error('settings unavailable');
    });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'resolution-failed' });
  });
});

describe('UtilityModelResolver — explicit refs are validated before use', () => {
  it('fails an override naming a non-chat provider without continuing down the chain', async () => {
    getSecret.mockResolvedValue('sk-test');
    settingsState.agentOverrides = { [AGENT]: { providerId: 'github', modelId: 'nope' } };
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'unsupported-provider' });
    expect(getEffectiveModel).not.toHaveBeenCalled();
  });

  it('fails a cloud override whose model is not active in the catalog', async () => {
    usableCredential('cred-retired', 'anthropic');
    findByProviderAndModelId.mockResolvedValue({ isActive: false });
    settingsState.agentOverrides = {
      [AGENT]: {
        providerId: 'anthropic',
        modelId: 'retired-model',
        credentialId: 'cred-retired',
      },
    };
    getEffectiveModel.mockResolvedValue({ providerId: 'ollama', modelId: 'llama3.2:1b' });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-model-for-agent' });
    expect(getEffectiveModel).not.toHaveBeenCalled();
  });

  it('accepts a local override without a catalog activity check — local runtimes serve what they serve', async () => {
    settingsState.agentOverrides = { [AGENT]: { providerId: 'ollama', modelId: 'qwen2.5:3b' } };

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: {
        providerId: 'ollama',
        modelId: 'qwen2.5:3b',
        source: 'agent-override',
        isLocal: true,
      },
    });
  });
});

/**
 * Step 3 pins whatever credential the agent's effective model names, and the
 * provider stack honors that pin at call time (`pickSecret` returns '' for a
 * broken pinned id). Reporting ok while pinning an unusable credential would
 * turn a credential problem into a model problem (`model-failing`, which only
 * lifts when a different model resolves), so repairing the credential would
 * never unblock the thread. Resolution fails here with `no-credentials` (a
 * `not-configured` halt, which a repair does clear).
 */
describe('UtilityModelResolver — a pinned own-model credential must work as pinned', () => {
  it('fails with no-credentials when the pinned credential has no usable secret, and does not prove usability with a different credential', async () => {
    // The credential row still exists; its secret is missing/undecryptable.
    getSafeById.mockResolvedValue({ id: 'cred-broken', providerId: 'anthropic' });
    getSecretById.mockResolvedValue(null);
    // A different, perfectly good anthropic credential sits in the store. It
    // must not be used to declare the broken pin usable.
    getSecret.mockResolvedValue('some-other-anthropic-key');
    getEffectiveModel.mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      credentialId: 'cred-broken',
    });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('fails when the pinned credential belongs to another provider, without attempting to decrypt it', async () => {
    getSafeById.mockResolvedValue({ id: 'cred-google', providerId: 'google' });
    getSecret.mockResolvedValue('some-other-anthropic-key');
    getEffectiveModel.mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      credentialId: 'cred-google',
    });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(getSecretById).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('fails when the pinned credential has been deleted outright', async () => {
    getSafeById.mockResolvedValue(null);
    getSecret.mockResolvedValue('some-other-openai-key');
    getEffectiveModel.mockResolvedValue({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      credentialId: 'cred-deleted',
    });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('does not let a registry env-var secret rescue a broken pin either', async () => {
    process.env.OPENAI_API_KEY_TEST_ONLY = 'env-key';
    try {
      getSafeById.mockResolvedValue({ id: 'cred-broken', providerId: 'openai' });
      getSecretById.mockResolvedValue(null);
      getEffectiveModel.mockResolvedValue({
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        credentialId: 'cred-broken',
      });

      const result = await resolve();
      expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    } finally {
      delete process.env.OPENAI_API_KEY_TEST_ONLY;
    }
  });

  it('leaves the no-pinned-credential case alone: the stored provider credential still resolves', async () => {
    // Scope boundary: "no credential selected" is a separate product question.
    getSecret.mockResolvedValue('sk-stored');
    getEffectiveModel.mockResolvedValue({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      credentialId: null,
    });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: { providerId: 'anthropic', source: 'own-model', credentialId: null },
    });
  });

  it('never validates a credential for a local own model — keyless runtimes have nothing to pin', async () => {
    getEffectiveModel.mockResolvedValue({
      providerId: 'ollama',
      modelId: 'llama3.2:1b',
      credentialId: 'cred-stale',
    });

    const result = await resolve();
    expect(result).toMatchObject({
      ok: true,
      model: { providerId: 'ollama', modelId: 'llama3.2:1b', source: 'own-model', isLocal: true },
    });
    expect(getSafeById).not.toHaveBeenCalled();
  });
});

/**
 * A lookup that errors (database unreachable) is not evidence that a pinned
 * credential is broken. It resolves to a retryable `resolution-failed`, which
 * summaryHalt does not halt on; only a credential that is really gone or
 * unusable resolves to `no-credentials`, and that detail names it.
 */
describe('UtilityModelResolver — transient lookups never masquerade as a broken credential', () => {
  const pinnedOwnModel = {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    credentialId: 'cred-pinned',
    source: 'agent',
  };

  it('a database error reading the pinned credential is retryable, not no-credentials', async () => {
    getSafeById.mockRejectedValue(new Error('connection terminated unexpectedly'));
    getEffectiveModel.mockResolvedValue(pinnedOwnModel);

    const result = await resolve();
    expect(result).toMatchObject({
      ok: false,
      reason: 'resolution-failed',
      retryable: true,
    });
  });

  it('a database error reading the pinned secret is retryable too', async () => {
    getSafeById.mockResolvedValue({ id: 'cred-pinned', providerId: 'anthropic' });
    getSecretById.mockRejectedValue(new Error('Connection terminated'));
    getEffectiveModel.mockResolvedValue(pinnedOwnModel);

    await expect(resolve()).resolves.toMatchObject({
      reason: 'resolution-failed',
      retryable: true,
    });
  });

  it('a secret that cannot be decrypted is unusable (halts) and says so', async () => {
    getSafeById.mockResolvedValue({
      id: 'cred-pinned',
      providerId: 'anthropic',
      label: 'Test Anthropic key',
    } as { id: string; providerId: string });
    getSecretById.mockRejectedValue(
      new CredentialDecryptError('cred-pinned', 'Unsupported state or unable to authenticate data')
    );
    getEffectiveModel.mockResolvedValue(pinnedOwnModel);

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(result).not.toHaveProperty('retryable');
    expect(!result.ok && result.detail).toMatch(/"Test Anthropic key".*cannot be decrypted/);
  });

  it('a deleted pinned credential names the provider and the credential in the detail', async () => {
    getSafeById.mockResolvedValue(null);
    settingsState.agentOverrides[AGENT] = {
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      credentialId: 'cred-deleted',
    };
    catalogActive();

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'no-credentials' });
    expect(!result.ok && result.detail).toMatch(
      /anthropic credential selected for this agent's summary model \(cred-deleted\) no longer exists/
    );
  });

  it("a database error reading the agent's model is retryable, not no-model-for-agent", async () => {
    getEffectiveModel.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(resolve()).resolves.toMatchObject({
      reason: 'resolution-failed',
      retryable: true,
    });
  });

  it('a database error resolving the unpinned primary is retryable', async () => {
    resolveCredentialIdForModel.mockRejectedValue(new Error('ECONNRESET'));
    getEffectiveModel.mockResolvedValue({ ...pinnedOwnModel, credentialId: null });

    await expect(resolve()).resolves.toMatchObject({
      reason: 'resolution-failed',
      retryable: true,
    });
  });

  it('a corrupt persisted override stays a non-retryable failure', async () => {
    settingsRead.mockImplementationOnce(async () => {
      throw new Error('settingsService.read(agent.x): persisted value fails schema — bad');
    });

    const result = await resolve();
    expect(result).toMatchObject({ ok: false, reason: 'resolution-failed' });
    expect(result).not.toHaveProperty('retryable');
  });
});
