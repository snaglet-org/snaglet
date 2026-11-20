import { useCallback, useEffect, useState } from 'react';
import { defaultCursorSpec, type CursorSpec } from '@snaglet/shared/cursor';
import type { SnagletAgent } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL, isWorkspaceEvent } from '@snaglet/shared/types/workspace-events';
import { agentsApi } from '@desktop/utils/api';
import { useWs } from '@desktop/ws/useWs';

export type SavedSpecs = ReadonlyMap<string, CursorSpec>;

/** Saved avatar specs by agent id; agents without a saved spec are omitted. */
export function buildSavedSpecs(
  agents: ReadonlyArray<Pick<SnagletAgent, 'id' | 'cursorSpec'>>
): SavedSpecs {
  const map = new Map<string, CursorSpec>();
  for (const agent of agents) if (agent.cursorSpec) map.set(agent.id, agent.cursorSpec);
  return map;
}

/** The agent's saved spec, else the one derived from its id. */
export function resolveSpec(saved: SavedSpecs, agentId: string): CursorSpec {
  return saved.get(agentId) ?? defaultCursorSpec(agentId);
}

// Module-level cache shared by every user of the hook.
let cache: SavedSpecs = new Map();
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Reload the agents list; quiet on failure (keeps whatever is cached). */
function refreshAgentSpecs(): Promise<void> {
  if (inflight) return inflight;
  inflight = agentsApi
    .list()
    .then((agents) => {
      cache = buildSavedSpecs(agents);
      listeners.forEach((fn) => fn());
    })
    .catch((err) => console.debug('[cursor] request failed', err))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test helper. */
export function resetAgentSpecCache(): void {
  cache = new Map();
  inflight = null;
}

/**
 * `specFor(agentId)`: the agent's saved avatar spec if known, else the default
 * derived from its id. Never blocks: the default shows while loading.
 */
export function useAgentSpecs(): { specFor: (agentId: string) => CursorSpec } {
  const [, setTick] = useState(0);
  const { addMessageListener, subscribe, unsubscribe, connectionState } = useWs();

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    void refreshAgentSpecs();
    const onFocus = () => void refreshAgentSpecs();
    window.addEventListener('focus', onFocus);
    return () => {
      listeners.delete(fn);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (connectionState !== 'open') return;
    subscribe(WORKSPACE_EVENT_CHANNEL);
    return () => unsubscribe(WORKSPACE_EVENT_CHANNEL);
  }, [connectionState, subscribe, unsubscribe]);

  useEffect(
    () =>
      addMessageListener((message) => {
        if (message.channel !== WORKSPACE_EVENT_CHANNEL) return;
        const evt = message.payload;
        if (isWorkspaceEvent(evt) && evt.type === 'agent.updated') void refreshAgentSpecs();
      }),
    [addMessageListener]
  );

  const specFor = useCallback((agentId: string) => resolveSpec(cache, agentId), []);
  return { specFor };
}
