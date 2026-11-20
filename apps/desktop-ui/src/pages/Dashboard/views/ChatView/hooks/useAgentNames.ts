import { useEffect, useMemo, useState } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { agentsApi } from '@desktop/utils/api';

/**
 * Agent id → display name for a thread's message authors and status pills.
 * Reads the whole roster, archived agents included, so past messages still
 * resolve to a name, and reads it again when an unknown participant turns up.
 * A subagent helper is never in the roster, so its thread passes the helper's
 * id and name.
 */
export function useAgentNames(
  participantAgentIds: string[],
  helperAgentId: string | null = null,
  helperName: string | null = null
): Map<string, string> {
  const [agents, setAgents] = useState<SnagletAgent[] | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let canceled = false;
    agentsApi
      .list({ includeArchived: true })
      .then((ags) => {
        if (!canceled) setAgents(ags);
      })
      .catch((err: unknown) => {
        console.error('useAgentNames: failed to load agents for name resolution', err);
      });
    return () => {
      canceled = true;
    };
  }, [reloadNonce]);

  // Keyed on which participants are unknown, so a roster that still lacks
  // them after a re-read is not read again in a loop, while a further
  // newcomer is.
  const unknownParticipants =
    agents === null
      ? ''
      : participantAgentIds
          .filter((id) => id !== helperAgentId && !agents.some((a) => a.id === id))
          .sort()
          .join(',');
  useEffect(() => {
    if (unknownParticipants) setReloadNonce((n) => n + 1);
  }, [unknownParticipants]);

  return useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(a.id, a.name);
    if (helperAgentId && helperName) map.set(helperAgentId, helperName);
    return map;
  }, [agents, helperAgentId, helperName]);
}
