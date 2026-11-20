import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { Button, Checkbox } from '@desktop/components';
import { mcpServersApi, type McpServerAgent } from '@desktop/utils/api';
import { showToast } from '@desktop/utils/toast';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { WsMessage } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL, isWorkspaceEvent } from '@snaglet/shared/types/workspace-events';
import { useWs } from '@desktop/ws/useWs';
import styles from './McpConnections.module.scss';

interface McpServerAgentsProps {
  serverId: string;
  serverName: string;
}

const enabledIds = (agents: McpServerAgent[]) =>
  agents.filter((agent) => agent.enabled).map((agent) => agent.id);

/**
 * Which agents may use this MCP server: a checkbox per
 * agent plus Enable for all / Turn off for all. Bulk changes show an Undo
 * toast that puts back the set from before; there is no confirmation.
 * Follows changes made elsewhere (an agent's own pane, another window)
 * through `agent.updated` events.
 */
export const McpServerAgents: FC<McpServerAgentsProps> = ({ serverId, serverName }) => {
  const [agents, setAgents] = useState<McpServerAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();

  /** Fetch the list; `keepError` leaves a save's error on screen. */
  const load = useCallback(
    async (keepError = false) => {
      try {
        const next = await mcpServersApi.listAgents(serverId);
        if (!savingRef.current) setAgents(next);
        if (!keepError) setError(null);
      } catch (err) {
        setError(getErrorMessage(err, 'Could not load agents'));
      }
    },
    [serverId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Any agent change (its servers, its name, created, archived, deleted) can
  // change this list; refetch, unless this section is saving.
  useEffect(() => {
    if (connectionState !== 'open') return;
    subscribe(WORKSPACE_EVENT_CHANNEL);
    return () => unsubscribe(WORKSPACE_EVENT_CHANNEL);
  }, [connectionState, subscribe, unsubscribe]);
  useEffect(
    () =>
      addMessageListener((message: WsMessage) => {
        if (message.channel !== WORKSPACE_EVENT_CHANNEL) return;
        const evt = message.payload;
        if (!isWorkspaceEvent(evt) || evt.type !== 'agent.updated' || savingRef.current) return;
        void load();
      }),
    [addMessageListener, load]
  );

  const save = useCallback(
    async (nextIds: string[], undo?: { ids: string[]; message: string }) => {
      if (!agents) return;
      const wanted = new Set(nextIds);
      savingRef.current = true;
      setSaving(true);
      setAgents(agents.map((agent) => ({ ...agent, enabled: wanted.has(agent.id) })));
      try {
        const saved = await mcpServersApi.setAgents(serverId, nextIds);
        setAgents(saved);
        setError(null);
        if (undo) {
          showToast(undo.message, {
            action: { label: 'Undo', run: () => void save(undo.ids) },
          });
        }
      } catch (err) {
        setError(getErrorMessage(err, 'Could not save'));
        savingRef.current = false;
        void load(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [agents, serverId, load]
  );

  if (!agents) {
    return (
      <section className={styles.section} aria-label="Agents">
        <h2 className={styles.sectionHeading}>Agents</h2>
        <p className={styles.agentsHint}>{error ?? 'Loading agents…'}</p>
      </section>
    );
  }

  const on = enabledIds(agents);
  const allOn = on.length === agents.length;

  return (
    <section className={styles.section} aria-label="Agents">
      <div className={styles.agentsHead}>
        <h2 className={styles.sectionHeading}>Agents</h2>
        <span className={styles.agentsCount} aria-live="polite">
          {agents.length === 0
            ? 'No agents yet'
            : `${on.length} of ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} can use it`}
        </span>
        <div className={styles.actions}>
          <Button
            size="xs"
            variant="neutral"
            disabled={saving || allOn || agents.length === 0}
            onClick={() =>
              void save(
                agents.map((agent) => agent.id),
                { ids: on, message: `${serverName} is on for every agent` }
              )
            }
          >
            Enable for all
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={saving || on.length === 0}
            onClick={() =>
              void save([], { ids: on, message: `${serverName} is off for every agent` })
            }
          >
            Turn off for all
          </Button>
        </div>
      </div>
      {error && (
        <p className={styles.agentsError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.agentsList}>
        {agents.map((agent) => (
          <Checkbox
            key={agent.id}
            checked={agent.enabled}
            disabled={saving}
            onChange={(next) =>
              void save(next ? [...on, agent.id] : on.filter((id) => id !== agent.id))
            }
          >
            {agent.name}
          </Checkbox>
        ))}
      </div>
    </section>
  );
};
