/**
 * The network guard. Right after a system wake or a server start the network
 * may not be back yet (Wi-Fi rejoining, DNS not answering), and an automation
 * woken then fails on its first provider call (`ENOTFOUND`). Within
 * {@link NETWORK_GUARD_WINDOW_MS} of the last activation ({@link
 * SystemActivation}) the scheduler first waits until the agent's provider
 * host answers: a DNS lookup, retried every few seconds for up to two
 * minutes. If it never answers, the run fails with "Network not ready"
 * instead. One wait is shared per activation and host, so every run due at a
 * wake waits on the same probe, and its result holds for that activation.
 * A first-open wake asks {@link NetworkGuard.check} before it is claimed
 * instead, which never blocks the scheduler: it starts that shared wait, and
 * after it (or outside the window) sends a single probe. Local providers (a
 * loopback base URL, Apple on-device) need no network and are never probed.
 */
import { lookup } from 'node:dns/promises';
import { Agents } from '@snaglet/db/tables/agents';
import { Providers } from '@snaglet/db/tables/providers';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import type { SystemActivation } from './systemWake';

/** How long after an activation a run waits for the network first. */
export const NETWORK_GUARD_WINDOW_MS = 3 * 60_000;
/** The longest a run waits for the network. */
const NETWORK_WAIT_MAX_MS = 2 * 60_000;
/** The time between probes. */
const NETWORK_PROBE_RETRY_MS = 3_000;
/** One probe's limit. */
const NETWORK_PROBE_TIMEOUT_MS = 5_000;
/** How long {@link NetworkGuard.check} lets the shared wait answer before saying `waiting`. */
const NETWORK_CHECK_GRACE_MS = 1_500;

/** {@link NetworkGuard.check}'s answer. */
export type NetworkCheck = 'ready' | 'waiting' | 'down';

/** The shared wait after one activation, and how it ended so far. */
interface NetworkWait {
  promise: Promise<void>;
  settled: 'pending' | 'ok' | 'failed';
}

/** Resolves when `host` answers; rejects (any error) when it does not. */
export type NetworkProbe = (host: string) => Promise<void>;

/** The default probe: the host resolves (DNS), within a few seconds. */
const dnsProbe: NetworkProbe = async (host) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup of ${host} timed out`)),
          NETWORK_PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** A run's network never came back within the wait. */
export class NetworkNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkNotReadyError';
  }
}

/** @public Constructed by unit tests with a fake probe and clock; production uses {@link networkGuard}. */
export interface NetworkGuardOptions {
  probe?: NetworkProbe;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
}

/** @public Unit-tested with a fake probe and clock; production uses {@link networkGuard}. */
export class NetworkGuard {
  private readonly probe: NetworkProbe;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;
  /** One wait per activation and host (`<at>|<host>`), only for the latest activation. */
  private readonly waits = new Map<string, NetworkWait>();

  constructor(options: NetworkGuardOptions = {}) {
    this.probe = options.probe ?? dnsProbe;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.windowMs = options.windowMs ?? NETWORK_GUARD_WINDOW_MS;
    this.maxWaitMs = options.maxWaitMs ?? NETWORK_WAIT_MAX_MS;
    this.retryMs = options.retryMs ?? NETWORK_PROBE_RETRY_MS;
  }

  /**
   * Resolves when a run may go: at once with no host, no activation, or more
   * than the window after it; inside the window once `host` answers. Rejects
   * with {@link NetworkNotReadyError} when it never answers in the wait.
   */
  ready(host: string | null, activation: SystemActivation | null): Promise<void> {
    if (!host || !activation || !this.inWindow(activation)) return Promise.resolve();
    return this.sharedWait(host, activation).promise;
  }

  /**
   * The answer without blocking, for a first-open wake before it is claimed:
   * `ready` when it may go now; `waiting` while the shared wait after this
   * activation is still probing (it starts it, and gives it a moment);
   * `down` when that wait failed, or a single probe (after it, or outside the
   * window) gets no answer.
   */
  async check(host: string | null, activation: SystemActivation | null): Promise<NetworkCheck> {
    if (!host) return 'ready';
    if (activation && this.inWindow(activation)) {
      const wait = this.sharedWait(host, activation);
      if (wait.settled === 'pending') {
        // How the wait ended is read from `settled` below; its failure is logged where it ends.
        const ended = wait.promise.then(
          () => true,
          () => false
        );
        await Promise.race([ended, this.sleep(NETWORK_CHECK_GRACE_MS)]);
      }
      if (wait.settled === 'pending') return 'waiting';
      if (wait.settled === 'ok') return 'ready';
    }
    try {
      await this.probe(host);
      return 'ready';
    } catch (err) {
      logger.info(`[network] ${host} did not answer: ${getErrorMessage(err)}`);
      return 'down';
    }
  }

  private inWindow(activation: SystemActivation): boolean {
    return this.now() - activation.at <= this.windowMs;
  }

  private sharedWait(host: string, activation: SystemActivation): NetworkWait {
    const prefix = `${activation.at}|`;
    const key = `${prefix}${host}`;
    let wait = this.waits.get(key);
    if (!wait) {
      for (const old of this.waits.keys()) if (!old.startsWith(prefix)) this.waits.delete(old);
      const entry: NetworkWait = { promise: this.waitFor(host, activation), settled: 'pending' };
      entry.promise.then(
        () => {
          entry.settled = 'ok';
        },
        () => {
          entry.settled = 'failed';
        }
      );
      wait = entry;
      this.waits.set(key, wait);
    }
    return wait;
  }

  private async waitFor(host: string, activation: SystemActivation): Promise<void> {
    const deadline = this.now() + this.maxWaitMs;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await this.probe(host);
        if (attempts > 1) {
          logger.info(`[network] ${host} answered after ${attempts} probes; dispatching`);
        }
        return;
      } catch (err) {
        const left = deadline - this.now();
        if (left <= 0) {
          logger.warn(`[network] ${host} never answered: ${getErrorMessage(err)}`);
          break;
        }
        await this.sleep(Math.min(this.retryMs, left));
      }
    }
    const since = activation.reason === 'wake' ? 'the computer woke' : 'Snaglet started';
    const minutes = Math.round(this.maxWaitMs / 60_000);
    throw new NetworkNotReadyError(
      `Network not ready: ${host} did not answer within ${minutes} minute${minutes === 1 ? '' : 's'} after ${since}.`
    );
  }
}

export const networkGuard = new NetworkGuard();

/** Provider hosts the chat adapters call when the provider row names no base URL. */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  codex: 'chatgpt.com',
  copilot: 'api.github.com',
  google: 'generativelanguage.googleapis.com',
  mistral: 'api.mistral.ai',
  deepseek: 'api.deepseek.com',
  xai: 'api.x.ai',
  together: 'api.together.xyz',
};

/** Providers whose adapters ignore the row's base URL. */
const PINNED_PROVIDERS = new Set(['anthropic', 'openai', 'codex']);

function isLoopback(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || name.startsWith('127.') || name === '0.0.0.0';
}

/**
 * The host to probe for a provider: its base URL's host when it has one
 * (and the adapter reads it), else the known one; null for a local or
 * unknown provider (no probe).
 */
export function providerProbeHost(providerId: string, baseUrl: string | null): string | null {
  if (!providerId) return null;
  if (baseUrl && !PINNED_PROVIDERS.has(providerId)) {
    try {
      const host = new URL(baseUrl).hostname;
      return host && !isLoopback(host) ? host : null;
    } catch {
      return null;
    }
  }
  return PROVIDER_HOSTS[providerId] ?? null;
}

/** The host to probe before waking `agentId` (its provider's), or null for none. */
export async function probeHostForAgent(agentId: string): Promise<string | null> {
  const agent = await Agents.findById(agentId);
  const providerId = agent?.providerId ?? '';
  if (!providerId) return null;
  const provider = await Providers.findProvider(providerId).catch(() => null);
  return providerProbeHost(providerId, provider?.baseUrl ?? null);
}
