import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@desktop/utils/api', () => ({
  agentsApi: { list: api.list },
}));

const agent = (id: string, name: string) => ({ id, name }) as never;

/** The cache is module state, so each test gets a fresh module instance. */
async function loadCache() {
  vi.resetModules();
  return import('./agentMentionCache');
}

/** Run a load to its end, through every retry wait. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('agentMentionCache', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    api.list.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  it('refreshAgents revalidates so agents created after hydration become mentionable', async () => {
    const { ensureAgents, refreshAgents, getAgentsCached } = await loadCache();
    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await ensureAgents();
    expect(getAgentsCached()).toHaveLength(1);

    // A warm cache must NOT skip the refetch (the original bug): a new agent
    // is created elsewhere, then the mention popover opens -> refreshAgents.
    api.list.mockResolvedValue([agent('a1', 'Clio'), agent('a2', 'Venus')]);
    // ensureAgents alone stays cheap and serves the cached roster…
    await expect(ensureAgents()).resolves.toHaveLength(1);
    // …while refreshAgents always refetches and updates the shared cache.
    await expect(refreshAgents()).resolves.toHaveLength(2);
    expect(getAgentsCached()).toHaveLength(2);
  });

  it('keeps the cached roster when a revalidation fails', async () => {
    const { ensureAgents, refreshAgents, getAgentsCached, agentsLoadFailed } = await loadCache();
    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await ensureAgents();

    api.list.mockRejectedValue(new Error('server down'));
    await expect(settle(refreshAgents())).resolves.toHaveLength(1);
    expect(getAgentsCached()).toHaveLength(1);
    // There is still a roster to show, so nothing reads as unavailable.
    expect(agentsLoadFailed()).toBe(false);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('does not poison the cache when the initial hydration fails', async () => {
    const { ensureAgents, refreshAgents, getAgentsCached } = await loadCache();
    api.list.mockRejectedValue(new Error('offline'));
    // Pre-fix behavior cached [] here, permanently disabling mentions.
    await expect(settle(ensureAgents())).resolves.toHaveLength(0);
    expect(getAgentsCached()).toBeNull();

    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await expect(refreshAgents()).resolves.toHaveLength(1);
    expect(getAgentsCached()).toHaveLength(1);
  });

  it('single-flights concurrent refreshes', async () => {
    const { refreshAgents } = await loadCache();
    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await Promise.all([refreshAgents(), refreshAgents()]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('retries a failing load a few times with growing waits, then stops and says so', async () => {
    const { ensureAgents, agentsLoadFailed, AGENT_LOAD_ATTEMPTS } = await loadCache();
    api.list.mockRejectedValue(new Error('server down'));

    const load = ensureAgents();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(api.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(api.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.list).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS);

    await expect(load).resolves.toEqual([]);
    expect(agentsLoadFailed()).toBe(true);

    // Nothing keeps asking on its own.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(api.list).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS);
  });

  it('leaves a failed load alone on hot paths until the cooldown, but retries on open', async () => {
    const { ensureAgents, refreshAgents, agentsLoadFailed, AGENT_LOAD_COOLDOWN_MS } =
      await loadCache();
    api.list.mockRejectedValue(new Error('server down'));
    await settle(ensureAgents());
    expect(api.list).toHaveBeenCalledTimes(3);

    // Keystrokes and rendered messages inside the cooldown cost nothing.
    await expect(ensureAgents()).resolves.toEqual([]);
    await expect(ensureAgents()).resolves.toEqual([]);
    expect(api.list).toHaveBeenCalledTimes(3);

    // Opening the mention list is a fresh, bounded round.
    await settle(refreshAgents());
    expect(api.list).toHaveBeenCalledTimes(6);

    // After the cooldown a hot path may try again; a success clears the state.
    await vi.advanceTimersByTimeAsync(AGENT_LOAD_COOLDOWN_MS);
    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await expect(ensureAgents()).resolves.toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(7);
    expect(agentsLoadFailed()).toBe(false);
  });

  it('stops retrying as soon as a try succeeds', async () => {
    const { ensureAgents, agentsLoadFailed } = await loadCache();
    api.list.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce([agent('a1', 'Clio')]);
    await expect(settle(ensureAgents())).resolves.toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(agentsLoadFailed()).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('agentMentionCache roster invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.list.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells subscribers when a load changes the agents or their names, not when it returns the same ones', async () => {
    const { ensureAgents, refreshAgents, subscribeAgentRoster } = await loadCache();
    const listener = vi.fn();
    const stop = subscribeAgentRoster(listener);

    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await ensureAgents();
    expect(listener).toHaveBeenCalledTimes(1);

    await refreshAgents();
    expect(listener).toHaveBeenCalledTimes(1);

    api.list.mockResolvedValue([agent('a1', 'Clio'), agent('test-agent-a', 'Test Agent A')]);
    await refreshAgents();
    expect(listener).toHaveBeenCalledTimes(2);

    api.list.mockResolvedValue([agent('a1', 'Clio'), agent('test-agent-a', 'Renamed Agent')]);
    await refreshAgents();
    expect(listener).toHaveBeenCalledTimes(3);

    stop();
    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await refreshAgents();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('keeps telling the other subscribers, and resolves the load, when one subscriber throws', async () => {
    const { ensureAgents, subscribeAgentRoster } = await loadCache();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    const stopBroken = subscribeAgentRoster(() => {
      throw new Error('editor gone');
    });
    const stopAfter = subscribeAgentRoster(after);

    api.list.mockResolvedValue([agent('a1', 'Clio')]);
    await expect(ensureAgents()).resolves.toHaveLength(1);
    expect(after).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[agentMentionCache] a roster listener failed',
      'editor gone'
    );

    stopBroken();
    stopAfter();
    consoleError.mockRestore();
  });

  it('leaves a roster nobody has loaded alone', async () => {
    const { invalidateAgentRoster, AGENT_INVALIDATE_DELAY_MS } = await loadCache();
    invalidateAgentRoster();
    await vi.advanceTimersByTimeAsync(AGENT_INVALIDATE_DELAY_MS * 2);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('refetches a warm roster once for a burst of agent events', async () => {
    const { ensureAgents, getAgentsCached, invalidateAgentRoster, AGENT_INVALIDATE_DELAY_MS } =
      await loadCache();
    api.list.mockResolvedValue([]);
    await ensureAgents();
    expect(api.list).toHaveBeenCalledTimes(1);

    api.list.mockResolvedValue([agent('test-agent-a', 'Test Agent A')]);
    invalidateAgentRoster();
    invalidateAgentRoster();
    await vi.advanceTimersByTimeAsync(AGENT_INVALIDATE_DELAY_MS - 1);
    invalidateAgentRoster();
    expect(api.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(getAgentsCached()).toEqual([agent('test-agent-a', 'Test Agent A')]);

    // A later event is a new burst.
    invalidateAgentRoster();
    await vi.advanceTimersByTimeAsync(AGENT_INVALIDATE_DELAY_MS);
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it('refetches after a load already in flight, which may predate the change', async () => {
    const { refreshAgents, getAgentsCached, invalidateAgentRoster, AGENT_INVALIDATE_DELAY_MS } =
      await loadCache();
    let finishFirst: (agents: never[]) => void = () => undefined;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const first = refreshAgents();
    invalidateAgentRoster();
    await vi.advanceTimersByTimeAsync(AGENT_INVALIDATE_DELAY_MS);
    expect(api.list).toHaveBeenCalledTimes(1);

    api.list.mockResolvedValue([agent('test-agent-a', 'Test Agent A')]);
    finishFirst([]);
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(getAgentsCached()).toEqual([agent('test-agent-a', 'Test Agent A')]);
  });
});
