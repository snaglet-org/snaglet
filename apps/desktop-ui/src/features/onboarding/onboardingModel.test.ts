/**
 * The first-run state machine: when agents can reply, when a window opens on
 * Get started, when a thread says to connect a provider, when Patty and
 * Clio have a model to answer with, what the pane offers once they were
 * removed, and when the person has a name of their own.
 */
import { describe, expect, it } from 'vitest';
import type { Provider, ProviderCredential } from '@desktop/utils/api';
import {
  agentModelState,
  fallbackAgent,
  helloAction,
  launchPanes,
  modelOffer,
  modelStepState,
  nameDraft,
  nameStepState,
  needsProviderBanner,
  opensGetStartedAtLaunch,
  providerState,
  sharedModelTargets,
  type AgentModelFields,
  type OnboardingProgress,
} from './onboardingModel';

function provider(id: string, authType: string, type: Provider['type'] = 'llm'): Provider {
  return {
    id,
    name: id,
    description: '',
    website: null,
    apiDocs: null,
    baseUrl: null,
    type,
    enabled: true,
    sortOrder: 0,
    primaryCredentialId: null,
    authTypes: [
      { id: `${id}:${authType}`, name: authType, type: authType, description: '', sortOrder: 0 },
    ],
    defaultMetadata: {},
  };
}

function credential(
  providerId: string,
  verificationStatus: ProviderCredential['verificationStatus']
): ProviderCredential {
  return {
    id: `cred-${providerId}-${verificationStatus}`,
    providerId,
    authTypeId: `${providerId}:api_key`,
    authType: 'api_key',
    label: 'Key',
    hasSecret: true,
    updatedAt: '2026-01-01T00:00:00Z',
    verificationStatus,
  };
}

const PROVIDERS = [
  provider('hosted', 'api_key'),
  provider('local', 'none'),
  provider('workspace', 'oauth', 'integration'),
];
const NO_PROGRESS: OnboardingProgress = {};

describe('providerState', () => {
  it('is none with nothing connected', () => {
    expect(providerState(PROVIDERS, [], NO_PROGRESS)).toEqual({ kind: 'none' });
  });

  it('ignores integration credentials', () => {
    expect(providerState(PROVIDERS, [credential('workspace', 'ok')], NO_PROGRESS)).toEqual({
      kind: 'none',
    });
  });

  it('is ready once a saved key passed its test', () => {
    expect(providerState(PROVIDERS, [credential('hosted', 'ok')], NO_PROGRESS)).toEqual({
      kind: 'ready',
      providerId: 'hosted',
    });
  });

  it('is connected, not ready, while keys are untested or failed', () => {
    expect(providerState(PROVIDERS, [credential('hosted', 'untested')], NO_PROGRESS)).toEqual({
      kind: 'connected',
      failed: false,
    });
    expect(providerState(PROVIDERS, [credential('hosted', 'fail')], NO_PROGRESS)).toEqual({
      kind: 'connected',
      failed: true,
    });
  });

  it('counts a passed test of a keyless provider as ready', () => {
    const progress = { providerReadyAt: '2026-01-01T00:00:00Z', providerId: 'local' };
    expect(providerState(PROVIDERS, [], progress)).toEqual({ kind: 'ready', providerId: 'local' });
  });

  it('counts a passed draft test only once that key is saved', () => {
    const progress = { providerReadyAt: '2026-01-01T00:00:00Z', providerId: 'hosted' };
    expect(providerState(PROVIDERS, [], progress)).toEqual({ kind: 'none' });
    expect(providerState(PROVIDERS, [credential('hosted', 'untested')], progress)).toEqual({
      kind: 'ready',
      providerId: 'hosted',
    });
  });
});

describe('opensGetStartedAtLaunch', () => {
  const seed = { status: 'done' as const };

  it('opens on a new install until the person skips or opens Patty', () => {
    const ready = { kind: 'ready', providerId: 'hosted' } as const;
    expect(opensGetStartedAtLaunch({ seed, progress: {}, provider: ready })).toBe(true);
    expect(
      opensGetStartedAtLaunch({ seed, progress: { providerSkippedAt: 'x' }, provider: ready })
    ).toBe(false);
    expect(
      opensGetStartedAtLaunch({ seed, progress: { pattyOpenedAt: 'x' }, provider: ready })
    ).toBe(false);
  });

  it('opens on an older workspace only while no provider is connected', () => {
    expect(opensGetStartedAtLaunch({ seed: null, progress: {}, provider: { kind: 'none' } })).toBe(
      true
    );
    expect(
      opensGetStartedAtLaunch({
        seed: null,
        progress: {},
        provider: { kind: 'connected', failed: false },
      })
    ).toBe(false);
  });
});

describe('launchPanes', () => {
  const seed = { status: 'done' as const };
  const none = { kind: 'none' } as const;
  const ready = { kind: 'ready', providerId: 'hosted' } as const;
  const newInstall = { seed, progress: {}, provider: none };
  const skipped = { seed, progress: { providerSkippedAt: 'x' }, provider: none };
  const metPatty = { seed, progress: { pattyOpenedAt: 'x' }, provider: ready };
  const olderNoProvider = { seed: null, progress: {}, provider: none };
  const olderConnected = { seed: null, progress: {}, provider: ready };
  const wide = { twoPanesFit: true };

  it('with Home on, opens Home with Get started beside it while the first run is unfinished', () => {
    expect(launchPanes({ hubEnabled: true, onboarding: newInstall, ...wide })).toBe(
      'home-and-get-started'
    );
    expect(launchPanes({ hubEnabled: true, onboarding: olderNoProvider, ...wide })).toBe(
      'home-and-get-started'
    );
  });

  it('with Home on, opens Home alone once the person skipped, met Patty, or has a provider', () => {
    for (const onboarding of [skipped, metPatty, olderConnected]) {
      expect(launchPanes({ hubEnabled: true, onboarding, ...wide })).toBe('home');
    }
  });

  it('with Home off, opens Get started alone, or nothing, as before', () => {
    expect(launchPanes({ hubEnabled: false, onboarding: newInstall, ...wide })).toBe('get-started');
    expect(launchPanes({ hubEnabled: false, onboarding: olderNoProvider, ...wide })).toBe(
      'get-started'
    );
    for (const onboarding of [skipped, metPatty, olderConnected]) {
      expect(launchPanes({ hubEnabled: false, onboarding, ...wide })).toBe('empty');
    }
  });

  it('opens Get started alone in a window too narrow for two panes', () => {
    expect(launchPanes({ hubEnabled: true, onboarding: newInstall, twoPanesFit: false })).toBe(
      'get-started'
    );
    expect(launchPanes({ hubEnabled: true, onboarding: metPatty, twoPanesFit: false })).toBe(
      'home'
    );
  });

  it('opens Home alone, or nothing, when the first-run state could not be read', () => {
    expect(launchPanes({ hubEnabled: true, onboarding: null, ...wide })).toBe('home');
    expect(launchPanes({ hubEnabled: false, onboarding: null, ...wide })).toBe('empty');
  });
});

describe('needsProviderBanner', () => {
  it('shows with nothing connected or only failed keys, not for an untested key', () => {
    expect(needsProviderBanner({ kind: 'none' })).toBe(true);
    expect(needsProviderBanner({ kind: 'connected', failed: true })).toBe(true);
    expect(needsProviderBanner({ kind: 'connected', failed: false })).toBe(false);
    expect(needsProviderBanner({ kind: 'ready', providerId: 'hosted' })).toBe(false);
  });
});

function agent(
  id: string,
  provider = '',
  modelId: string | null = null,
  credentialId: string | null = null
): AgentModelFields {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), provider, modelId, credentialId };
}

describe('agentModelState', () => {
  it('is none without a provider or a model', () => {
    expect(agentModelState(agent('patty'), PROVIDERS, [])).toEqual({ kind: 'none' });
    expect(agentModelState(agent('patty', 'hosted'), PROVIDERS, [])).toEqual({ kind: 'none' });
  });

  it('is set when its provider has a key that has not failed, or needs no key', () => {
    const tested = [credential('hosted', 'ok')];
    expect(agentModelState(agent('patty', 'hosted', 'mid'), PROVIDERS, tested)).toEqual({
      kind: 'set',
      providerId: 'hosted',
      modelId: 'mid',
    });
    const untested = [credential('hosted', 'untested')];
    expect(agentModelState(agent('patty', 'hosted', 'mid'), PROVIDERS, untested).kind).toBe('set');
    expect(agentModelState(agent('patty', 'local', 'llama'), PROVIDERS, []).kind).toBe('set');
  });

  it('is unavailable when its provider has no key, only failed ones, or is unknown', () => {
    expect(agentModelState(agent('patty', 'hosted', 'mid'), PROVIDERS, [])).toEqual({
      kind: 'unavailable',
      providerId: 'hosted',
      modelId: 'mid',
    });
    const failed = [credential('hosted', 'fail')];
    expect(agentModelState(agent('patty', 'hosted', 'mid'), PROVIDERS, failed).kind).toBe(
      'unavailable'
    );
    expect(agentModelState(agent('patty', 'gone', 'mid'), PROVIDERS, []).kind).toBe('unavailable');
  });

  it('judges a pinned key by itself', () => {
    const keys = [credential('hosted', 'ok'), credential('hosted', 'fail')];
    const pinnedFailed = agent('patty', 'hosted', 'mid', 'cred-hosted-fail');
    expect(agentModelState(pinnedFailed, PROVIDERS, keys).kind).toBe('unavailable');
    const pinnedGone = agent('patty', 'hosted', 'mid', 'cred-deleted');
    expect(agentModelState(pinnedGone, PROVIDERS, keys).kind).toBe('set');
  });
});

describe('sharedModelTargets', () => {
  it('sets both starter agents while neither has a model', () => {
    const agents = [agent('patty'), agent('clio')];
    expect(sharedModelTargets(agents).map((a) => a.id)).toEqual(['patty', 'clio']);
  });

  it('includes an agent with the same model as the first, or none', () => {
    expect(
      sharedModelTargets([agent('patty', 'hosted', 'mid'), agent('clio', 'hosted', 'mid')]).map(
        (a) => a.id
      )
    ).toEqual(['patty', 'clio']);
    expect(
      sharedModelTargets([agent('patty', 'hosted', 'mid'), agent('clio')]).map((a) => a.id)
    ).toEqual(['patty', 'clio']);
  });

  it('leaves out an agent given its own model', () => {
    expect(
      sharedModelTargets([agent('patty', 'hosted', 'mid'), agent('clio', 'local', 'llama')]).map(
        (a) => a.id
      )
    ).toEqual(['patty']);
    expect(
      sharedModelTargets([agent('patty'), agent('clio', 'local', 'llama')]).map((a) => a.id)
    ).toEqual(['patty']);
  });

  it('is empty with no starter agents', () => {
    expect(sharedModelTargets([])).toEqual([]);
  });
});

describe('modelOffer', () => {
  const tested = [credential('hosted', 'ok')];
  const suggestion = { providerId: 'hosted', modelId: 'mid', displayName: 'Mid' };

  it('offers the suggested model for every agent without one, never saving it', () => {
    expect(
      modelOffer({
        agents: [agent('patty'), agent('clio')],
        providers: PROVIDERS,
        credentials: tested,
        suggestion,
      })
    ).toEqual({
      source: 'suggested',
      providerId: 'hosted',
      modelId: 'mid',
      credentialId: null,
      agentIds: ['patty', 'clio'],
    });
  });

  it("offers Patty's working model to Clio when only Clio lacks one", () => {
    expect(
      modelOffer({
        agents: [agent('patty', 'hosted', 'mid', 'cred-hosted-ok'), agent('clio')],
        providers: PROVIDERS,
        credentials: tested,
        suggestion: { providerId: 'hosted', modelId: 'other', displayName: 'Other' },
      })
    ).toEqual({
      source: 'shared',
      providerId: 'hosted',
      modelId: 'mid',
      credentialId: 'cred-hosted-ok',
      agentIds: ['clio'],
    });
  });

  it('offers nothing once every shared target works, or with no suggestion', () => {
    const working = [agent('patty', 'hosted', 'mid'), agent('clio', 'hosted', 'mid')];
    expect(
      modelOffer({ agents: working, providers: PROVIDERS, credentials: tested, suggestion })
    ).toBeNull();
    expect(
      modelOffer({
        agents: [agent('patty'), agent('clio')],
        providers: PROVIDERS,
        credentials: tested,
        suggestion: null,
      })
    ).toBeNull();
  });

  it('leaves an agent with its own working model out of the offer', () => {
    const offer = modelOffer({
      agents: [agent('patty'), agent('clio', 'local', 'llama')],
      providers: PROVIDERS,
      credentials: tested,
      suggestion,
    });
    expect(offer?.agentIds).toEqual(['patty']);
  });
});

describe('modelStepState', () => {
  const none = { kind: 'none' } as const;
  const set = { kind: 'set', providerId: 'hosted', modelId: 'mid' } as const;
  const ready = { kind: 'ready', providerId: 'hosted' } as const;

  it('waits for a provider, then is open until every starter agent has a working model', () => {
    expect(modelStepState({ kind: 'none' }, [none, none])).toBe('waiting');
    expect(modelStepState({ kind: 'connected', failed: false }, [none, none])).toBe('open');
    expect(modelStepState(ready, [set, none])).toBe('open');
    expect(modelStepState(ready, [set, set])).toBe('done');
  });

  it('is done for agents on a keyless provider even before step 1 is', () => {
    expect(modelStepState({ kind: 'none' }, [set])).toBe('done');
  });

  it('is never done with no starter agents', () => {
    expect(modelStepState(ready, [])).toBe('open');
  });
});

describe('fallbackAgent', () => {
  const tested = [credential('hosted', 'ok')];

  it('is the first agent with a working model', () => {
    const agents = [
      agent('scout'),
      agent('quill', 'hosted', 'mid'),
      agent('ada', 'local', 'llama'),
    ];
    expect(fallbackAgent(agents, PROVIDERS, tested)).toEqual({
      agent: agents[1],
      state: { kind: 'set', providerId: 'hosted', modelId: 'mid' },
    });
  });

  it('is the first agent when none has a working model yet', () => {
    const agents = [agent('scout'), agent('quill', 'hosted', 'mid')];
    expect(fallbackAgent(agents, PROVIDERS, [])).toEqual({
      agent: agents[0],
      state: { kind: 'none' },
    });
  });

  it('is null with no other agent', () => {
    expect(fallbackAgent([], PROVIDERS, tested)).toBeNull();
  });
});

describe('helloAction', () => {
  const seed = {
    status: 'done' as const,
    threads: { patty: 'thread-patty', clio: 'thread-clio' },
  };

  it('greets Patty in her thread while she is there', () => {
    expect(helloAction({ starters: [agent('patty'), agent('clio')], others: [], seed })).toEqual({
      kind: 'starter',
      agentId: 'patty',
      threadId: 'thread-patty',
    });
  });

  it('greets Clio in her thread once Patty is removed', () => {
    expect(helloAction({ starters: [agent('clio')], others: [], seed })).toEqual({
      kind: 'starter',
      agentId: 'clio',
      threadId: 'thread-clio',
    });
  });

  it('has no thread for a starter agent the seed made none for', () => {
    expect(helloAction({ starters: [agent('clio')], others: [], seed: null })).toEqual({
      kind: 'starter',
      agentId: 'clio',
      threadId: null,
    });
  });

  it('greets Patty while the starter agents are not read yet', () => {
    expect(helloAction({ starters: null, others: [], seed })).toEqual({
      kind: 'starter',
      agentId: 'patty',
      threadId: 'thread-patty',
    });
  });

  it('with both removed, starts a thread when another agent exists, else creates one', () => {
    expect(helloAction({ starters: [], others: [agent('scout')], seed })).toEqual({
      kind: 'thread',
    });
    expect(helloAction({ starters: [], others: [], seed })).toEqual({ kind: 'create' });
  });
});

describe('nameStepState', () => {
  it('is open while the name is the one a new workspace starts with, or not read yet', () => {
    expect(nameStepState('Local User')).toBe('open');
    expect(nameStepState('local user')).toBe('open');
    expect(nameStepState(null)).toBe('open');
  });

  it('is done with a name of their own', () => {
    expect(nameStepState('Robin')).toBe('done');
  });
});

describe('nameDraft', () => {
  it('starts empty for the starting name, and with their own name otherwise', () => {
    expect(nameDraft('Local User')).toBe('');
    expect(nameDraft(null)).toBe('');
    expect(nameDraft('Robin')).toBe('Robin');
  });
});
