/**
 * The first-run state, as pure functions over what the server already
 * stores: the onboarding seed record and this person's progress (both
 * settings in the `onboarding` category), the providers, the saved
 * credentials, the starter agents' own model fields and the user's name.
 */
import { isDefaultUserName } from '@snaglet/shared/constants';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { Provider, ProviderCredential, ProviderDefaultModel } from '@desktop/utils/api';

/**
 * The "Set your name" step: done once the person's name is no longer the one
 * a new workspace starts with. Open while the name is not read yet; it never
 * holds up the other steps.
 */
export function nameStepState(name: string | null): 'open' | 'done' {
  return name !== null && !isDefaultUserName(name) ? 'done' : 'open';
}

/** What the name field starts with: the person's own name, else nothing. */
export function nameDraft(name: string | null): string {
  return nameStepState(name) === 'done' ? (name ?? '') : '';
}

/** What the onboarding seed made on a new install (`onboarding.seed`). */
export interface OnboardingSeed {
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  folders?: Record<string, string>;
  docs?: Record<string, string>;
  tables?: Record<string, string>;
  threads?: Record<string, string>;
}

/** One person's place in the Get started pane (`onboarding.progress[userId]`). */
export interface OnboardingProgress {
  providerSkippedAt?: string;
  providerReadyAt?: string;
  providerId?: string;
  pattyOpenedAt?: string;
}

export type ProviderState =
  /** Nothing connected yet. */
  | { kind: 'none' }
  /** Connected, but no test has passed yet. */
  | { kind: 'connected'; failed: boolean }
  /** A test passed: agents can reply. */
  | { kind: 'ready'; providerId: string };

/** Providers that need no key: the connection itself is the test. */
function keyless(provider: Provider): boolean {
  return provider.authTypes.length > 0 && provider.authTypes.every((a) => a.type === 'none');
}

/** Credentials of model providers (not integrations such as Google Workspace). */
export function modelCredentials(
  providers: readonly Provider[],
  credentials: readonly ProviderCredential[]
): ProviderCredential[] {
  const llm = new Set(providers.filter((p) => p.type === 'llm').map((p) => p.id));
  return credentials.filter((c) => llm.has(c.providerId));
}

/**
 * Whether agents can reply. A saved key whose test passed is ready; so is a
 * test that passed in the Get started pane for a keyless provider, or for a
 * provider whose key was then saved.
 */
export function providerState(
  providers: readonly Provider[],
  credentials: readonly ProviderCredential[],
  progress: OnboardingProgress
): ProviderState {
  const models = modelCredentials(providers, credentials);
  const working = models.find((c) => c.verificationStatus === 'ok');
  if (working) return { kind: 'ready', providerId: working.providerId };
  const tested = progress.providerReadyAt ? progress.providerId : undefined;
  const testedProvider = tested ? providers.find((p) => p.id === tested) : undefined;
  if (
    testedProvider &&
    (keyless(testedProvider) || models.some((c) => c.providerId === testedProvider.id))
  ) {
    return { kind: 'ready', providerId: testedProvider.id };
  }
  if (models.length === 0) return { kind: 'none' };
  return { kind: 'connected', failed: models.every((c) => c.verificationStatus === 'fail') };
}

/**
 * Whether a window with nothing to restore opens on Get started. A new
 * install (it has a seed record) does until the person skips the provider
 * step or opens Patty's thread; an older database does only while no model
 * provider is connected.
 */
export function opensGetStartedAtLaunch(input: {
  seed: OnboardingSeed | null;
  progress: OnboardingProgress;
  provider: ProviderState;
}): boolean {
  if (input.progress.providerSkippedAt || input.progress.pattyOpenedAt) return false;
  if (input.seed) return true;
  return input.provider.kind === 'none';
}

/** What a window with nothing to restore opens with. */
export type LaunchPanes = 'empty' | 'home' | 'get-started' | 'home-and-get-started';

/**
 * Home opens with the `hub_home` flag; Get started opens while
 * `opensGetStartedAtLaunch` says so. With both, Home opens with Get started
 * beside it. A window too narrow for two panes opens Get started alone: it is
 * the one that tells a new person what to do first. A first-run state that
 * could not be read (`null`) opens no Get started.
 */
export function launchPanes(input: {
  hubEnabled: boolean;
  onboarding: Parameters<typeof opensGetStartedAtLaunch>[0] | null;
  twoPanesFit: boolean;
}): LaunchPanes {
  const getStarted = input.onboarding !== null && opensGetStartedAtLaunch(input.onboarding);
  if (!getStarted) return input.hubEnabled ? 'home' : 'empty';
  return input.hubEnabled && input.twoPanesFit ? 'home-and-get-started' : 'get-started';
}

/**
 * Whether a thread shows "Connect a provider so … can reply": nothing is
 * connected, or every saved key failed its test. A key not tested yet may
 * well work, so it gets no banner.
 */
export function needsProviderBanner(provider: ProviderState): boolean {
  return provider.kind === 'none' || (provider.kind === 'connected' && provider.failed);
}

/** The agents the Get started pane gives a model, in the order it lists them. */
export const STARTER_AGENT_IDS = ['patty', 'clio'] as const;

export type StarterAgentId = (typeof STARTER_AGENT_IDS)[number];

/** What the pane reads of an agent: the model fields its row stores. */
export type AgentModelFields = Pick<
  SnagletAgent,
  'id' | 'name' | 'provider' | 'modelId' | 'credentialId'
>;

export type AgentModelState =
  /** No provider or no model: a message fails with "No model configured" unless the agent adopts one. */
  | { kind: 'none' }
  /** A model whose provider cannot run it: no key, only failed keys, or not an enabled model provider. */
  | { kind: 'unavailable'; providerId: string; modelId: string }
  /** A model from a connected provider. */
  | { kind: 'set'; providerId: string; modelId: string };

/**
 * Whether an agent has a model it can answer with. The run uses the agent's
 * pinned key when it still exists, else the provider's own, so a pinned key
 * is judged by itself; a key that was never tested counts, as on the run path.
 */
export function agentModelState(
  agent: AgentModelFields,
  providers: readonly Provider[],
  credentials: readonly ProviderCredential[]
): AgentModelState {
  const providerId = agent.provider?.trim() ?? '';
  const modelId = agent.modelId?.trim() ?? '';
  if (!providerId || !modelId) return { kind: 'none' };
  const provider = providers.find((p) => p.id === providerId);
  const keys = credentials.filter((c) => c.providerId === providerId);
  const pinned = keys.find((c) => c.id === agent.credentialId);
  const usable =
    provider !== undefined &&
    provider.type === 'llm' &&
    provider.enabled &&
    (keyless(provider) || (pinned ? [pinned] : keys).some((c) => c.verificationStatus !== 'fail'));
  return { kind: usable ? 'set' : 'unavailable', providerId, modelId };
}

/**
 * The starter agents one choice in the pane sets: the first one listed, and
 * each other one with no model or with the first one's model. An agent given
 * a different model on its own page keeps it.
 */
export function sharedModelTargets<T extends AgentModelFields>(agents: readonly T[]): T[] {
  const [lead, ...rest] = agents;
  if (!lead) return [];
  const follows = (other: T) =>
    !other.provider ||
    !other.modelId ||
    (other.provider === lead.provider && other.modelId === lead.modelId);
  return [lead, ...rest.filter(follows)];
}

/** A model the pane offers with one click; nothing is saved until the person takes it. */
export interface ModelOffer {
  /** `suggested`: a connected provider's default model. `shared`: the first agent's working model, for the others. */
  source: 'suggested' | 'shared';
  providerId: string;
  modelId: string;
  credentialId: string | null;
  /** The shared targets that have no working model yet. */
  agentIds: string[];
}

/**
 * What to offer the shared targets still lacking a working model: the first
 * agent's model when it works (so Clio can follow Patty), else the model an
 * agent with none would adopt on its first run. Null when nothing is lacking
 * or nothing usable is connected.
 */
export function modelOffer(input: {
  agents: readonly AgentModelFields[];
  providers: readonly Provider[];
  credentials: readonly ProviderCredential[];
  suggestion: ProviderDefaultModel | null;
}): ModelOffer | null {
  const targets = sharedModelTargets(input.agents);
  const works = (agent: AgentModelFields) =>
    agentModelState(agent, input.providers, input.credentials).kind === 'set';
  const lacking = targets.filter((agent) => !works(agent)).map((agent) => agent.id);
  const lead = targets[0];
  if (!lead || lacking.length === 0) return null;
  if (works(lead)) {
    return {
      source: 'shared',
      providerId: lead.provider,
      modelId: lead.modelId ?? '',
      credentialId: lead.credentialId ?? null,
      agentIds: lacking,
    };
  }
  if (!input.suggestion) return null;
  return {
    source: 'suggested',
    providerId: input.suggestion.providerId,
    modelId: input.suggestion.modelId,
    credentialId: null,
    agentIds: lacking,
  };
}

/**
 * The "Choose a model" step: waiting (no controls) until a provider is
 * connected, done once every starter agent has a working model.
 */
export function modelStepState(
  provider: ProviderState,
  agents: readonly AgentModelState[]
): 'waiting' | 'open' | 'done' {
  if (agents.length > 0 && agents.every((a) => a.kind === 'set')) return 'done';
  return provider.kind === 'none' ? 'waiting' : 'open';
}

/**
 * With both starter agents removed, the model step becomes "Create an agent"
 * and lists one of the other agents: the first with a working model (the step
 * is then done), else the first one. Null while there is no other agent.
 */
export function fallbackAgent<T extends AgentModelFields>(
  agents: readonly T[],
  providers: readonly Provider[],
  credentials: readonly ProviderCredential[]
): { agent: T; state: AgentModelState } | null {
  const states = agents.map((agent) => agentModelState(agent, providers, credentials));
  const working = states.findIndex((state) => state.kind === 'set');
  const index = working >= 0 ? working : 0;
  const agent = agents[index];
  return agent ? { agent, state: states[index] ?? { kind: 'none' } } : null;
}

/** What the last step of the Get started pane offers. */
export type HelloAction =
  /** Open the thread the seed made for this starter agent (`threadId`), else its page. */
  | { kind: 'starter'; agentId: StarterAgentId; threadId: string | null }
  /** No starter agent is left, but another agent is: start a thread. */
  | { kind: 'thread' }
  /** No agent is left: create one. */
  | { kind: 'create' };

/**
 * Who the last step greets: Patty, else Clio, else (both removed) a new
 * thread when another agent exists, or a new agent when none does. Starter
 * agents not read yet (`null`) count as present, so the pane greets Patty.
 */
export function helloAction(input: {
  starters: readonly Pick<AgentModelFields, 'id'>[] | null;
  others: readonly Pick<AgentModelFields, 'id'>[];
  seed: OnboardingSeed | null;
}): HelloAction {
  const { starters } = input;
  const agentId = STARTER_AGENT_IDS.find(
    (id) => starters === null || starters.some((agent) => agent.id === id)
  );
  if (agentId) {
    return { kind: 'starter', agentId, threadId: input.seed?.threads?.[agentId] ?? null };
  }
  return input.others.length > 0 ? { kind: 'thread' } : { kind: 'create' };
}
