/**
 * Patty and Clio as the Get started pane shows them: their rows (an archived
 * or deleted one is left out) and the model an agent with none would take now.
 * Once neither is left, the workspace's other agents too, so the pane can
 * offer them instead.
 *
 * Read on mount, when the window regains focus, when either agent changes
 * anywhere (`agent.updated`, so a model picked on the agent's page or adopted
 * on a first run shows here at once; with neither left, when any agent
 * changes), and whenever `revision` changes: a provider connected or a model
 * imported can change the suggestion. A new key's models are imported in the
 * background after it is saved, so a revision change reads once more a few
 * seconds later.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { agentsApi, providersApi, type ProviderDefaultModel } from '@desktop/utils/api';
import { subscribeAgentEvents } from '@desktop/utils/agentEvents';
import { STARTER_AGENT_IDS } from './onboardingModel';

/** How long after a revision change to read once more, for a catalog still importing. */
const CATALOG_SETTLE_MS = 3000;

export interface ChosenModel {
  providerId: string;
  modelId: string;
  credentialId: string | null;
}

interface StarterAgents {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** The starter agents that exist, in pane order. */
  agents: SnagletAgent[];
  /** The other agents that are not archived, read only while no starter agent is left. */
  others: SnagletAgent[];
  suggestion: ProviderDefaultModel | null;
  /** Save one model on each named agent. Rejects when a save fails. */
  saveModel: (agentIds: readonly string[], model: ChosenModel) => Promise<void>;
}

const STARTER_IDS: ReadonlySet<string> = new Set(STARTER_AGENT_IDS);

async function readAgent(id: string): Promise<SnagletAgent | null> {
  try {
    const agent = await agentsApi.get(id);
    return agent.archived ? null : agent;
  } catch (err) {
    if ((err as { status?: unknown } | null)?.status === 404) return null;
    throw err;
  }
}

export function useStarterAgents(revision: string): StarterAgents {
  const [state, setState] = useState<Omit<StarterAgents, 'saveModel'>>({
    status: 'loading',
    error: null,
    agents: [],
    others: [],
    suggestion: null,
  });
  // Only the newest read lands, so an older one never replaces a save.
  const latest = useRef(0);
  // With no starter agent left, a change to any agent can change what the pane offers.
  const noStarters = useRef(false);

  const read = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const [rows, suggestion] = await Promise.all([
        Promise.all(STARTER_AGENT_IDS.map(readAgent)),
        providersApi.defaultModel().catch(() => null),
      ]);
      const agents = rows.filter((agent): agent is SnagletAgent => agent !== null);
      const others = agents.length === 0 ? await agentsApi.list() : [];
      if (ticket !== latest.current) return;
      noStarters.current = agents.length === 0;
      setState({ status: 'ready', error: null, agents, others, suggestion });
    } catch (err) {
      if (ticket !== latest.current) return;
      setState((prev) => ({
        ...prev,
        status: prev.status === 'ready' ? 'ready' : 'error',
        error: getErrorMessage(err, 'Could not load your agents'),
      }));
    }
  }, []);

  useEffect(() => {
    void read();
    const settle = window.setTimeout(() => void read(), CATALOG_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [read, revision]);

  useEffect(() => {
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    const unsubscribe = subscribeAgentEvents((event) => {
      if (
        event.type === 'agents.invalidated' ||
        STARTER_IDS.has(event.agentId) ||
        noStarters.current
      ) {
        void read();
      }
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [read]);

  const saveModel = useCallback(async (agentIds: readonly string[], model: ChosenModel) => {
    latest.current += 1;
    const saved = await Promise.all(
      agentIds.map((id) =>
        agentsApi.update(id, {
          provider: model.providerId,
          modelId: model.modelId,
          credentialId: model.credentialId,
        })
      )
    );
    const byId = new Map(saved.map((agent) => [agent.id, agent] as const));
    setState((prev) => ({
      ...prev,
      agents: prev.agents.map((agent) => byId.get(agent.id) ?? agent),
    }));
  }, []);

  return { ...state, saveModel };
}
