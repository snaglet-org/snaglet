/**
 * NetworkGuard with a fake probe and clock: no wait without a host, an
 * activation or outside the window after it; inside it, a probe every few
 * seconds until the host answers, at most the wait, then "Network not
 * ready" naming the host and what it waited after. Runs due at one
 * activation share one wait (and its result); a new activation starts a new
 * one. Provider hosts: the known one, a base URL's host, none for local ones.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  NetworkGuard,
  NetworkNotReadyError,
  providerProbeHost,
} from '@server/services/systemActivity/networkGuard';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const HOST = 'api.example.com';

/** A guard whose clock moves only when it sleeps; the probe fails `failures` times. */
function guardWith(failures: number) {
  let now = T0;
  let left = failures;
  const probe = jest.fn(async (host: string) => {
    if (left > 0) {
      left -= 1;
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    }
  });
  const sleep = jest.fn(async (ms: number) => {
    now += ms;
  });
  const guard = new NetworkGuard({
    probe,
    sleep,
    now: () => now,
    windowMs: 180_000,
    maxWaitMs: 120_000,
    retryMs: 3_000,
  });
  return { guard, probe, sleep, now: () => now };
}

describe('NetworkGuard', () => {
  it('does not wait without a host, without an activation, or outside the window', async () => {
    const { guard, probe } = guardWith(0);
    await guard.ready(null, { at: T0, reason: 'wake' });
    await guard.ready(HOST, null);
    await guard.ready(HOST, { at: T0 - 180_001, reason: 'wake' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes every few seconds until the host answers, then lets the run go', async () => {
    const { guard, probe, sleep, now } = guardWith(4);
    await expect(guard.ready(HOST, { at: T0, reason: 'wake' })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(5);
    expect(probe).toHaveBeenCalledWith(HOST);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(now() - T0).toBe(12_000);
  });

  it('fails with "Network not ready" when the host never answers within the wait', async () => {
    const { guard, probe, now } = guardWith(Number.POSITIVE_INFINITY);
    const wait = guard.ready(HOST, { at: T0, reason: 'wake' });
    await expect(wait).rejects.toBeInstanceOf(NetworkNotReadyError);
    await expect(wait).rejects.toThrow(
      'Network not ready: api.example.com did not answer within 2 minutes after the computer woke.'
    );
    expect(now() - T0).toBe(120_000);
    // A probe at the start, then one every 3 s up to the deadline.
    expect(probe).toHaveBeenCalledTimes(41);
  });

  it('names a server start in the error after one', async () => {
    const { guard } = guardWith(Number.POSITIVE_INFINITY);
    await expect(guard.ready(HOST, { at: T0, reason: 'start' })).rejects.toThrow(
      'Network not ready: api.example.com did not answer within 2 minutes after Snaglet started.'
    );
  });

  it('shares one wait per activation and host, and starts over at the next activation', async () => {
    const { guard, probe } = guardWith(1);
    const activation = { at: T0, reason: 'wake' as const };
    await Promise.all([guard.ready(HOST, activation), guard.ready(HOST, activation)]);
    expect(probe).toHaveBeenCalledTimes(2);
    await guard.ready(HOST, activation);
    expect(probe).toHaveBeenCalledTimes(2);
    await guard.ready('api.other.example', activation);
    expect(probe).toHaveBeenCalledTimes(3);
    await guard.ready(HOST, { at: T0 + 1_000, reason: 'wake' });
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe('NetworkGuard.check (a first-open wake, before it is claimed)', () => {
  it('is ready without a host, and after a wait that answered', async () => {
    const { guard, probe } = guardWith(0);
    expect(await guard.check(null, { at: T0, reason: 'wake' })).toBe('ready');
    expect(probe).not.toHaveBeenCalled();
    expect(await guard.check(HOST, { at: T0, reason: 'wake' })).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(1);
    // The wait's answer holds for that activation: no second probe.
    expect(await guard.check(HOST, { at: T0, reason: 'wake' })).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('says waiting, without blocking, while the shared wait is still probing', async () => {
    let now = T0;
    const probe = jest.fn(() => new Promise<void>(() => undefined));
    const guard = new NetworkGuard({
      probe,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(await guard.check(HOST, { at: T0, reason: 'start' })).toBe('waiting');
    expect(await guard.check(HOST, { at: T0, reason: 'start' })).toBe('waiting');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('after a failed wait, or outside the window, sends a single probe each time', async () => {
    const { guard, probe } = guardWith(Number.POSITIVE_INFINITY);
    const activation = { at: T0, reason: 'wake' as const };
    await expect(guard.ready(HOST, activation)).rejects.toBeInstanceOf(NetworkNotReadyError);
    const afterWait = probe.mock.calls.length;
    expect(await guard.check(HOST, activation)).toBe('down');
    expect(probe).toHaveBeenCalledTimes(afterWait + 1);

    const later = guardWith(1);
    const old = { at: T0 - 600_000, reason: 'wake' as const };
    expect(await later.guard.check(HOST, old)).toBe('down');
    expect(await later.guard.check(HOST, old)).toBe('ready');
    expect(later.probe).toHaveBeenCalledTimes(2);
    expect(later.sleep).not.toHaveBeenCalled();
  });
});

describe('providerProbeHost', () => {
  it('uses the known host, a base URL’s host where the adapter reads it, none for local ones', () => {
    expect(providerProbeHost('anthropic', null)).toBe('api.anthropic.com');
    expect(providerProbeHost('openai', 'https://proxy.example.com/v1')).toBe('api.openai.com');
    expect(providerProbeHost('together', 'https://llm.example.com/v1')).toBe('llm.example.com');
    expect(providerProbeHost('ollama', 'http://localhost:11434')).toBeNull();
    expect(providerProbeHost('lm-studio', 'http://127.0.0.1:1234/v1')).toBeNull();
    expect(providerProbeHost('ollama', null)).toBeNull();
    expect(providerProbeHost('apple-on-device', null)).toBeNull();
    expect(providerProbeHost('', null)).toBeNull();
    expect(providerProbeHost('together', 'not a url')).toBeNull();
  });
});
