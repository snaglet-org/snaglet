import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL, isWorkspaceEvent } from '@snaglet/shared/types/workspace-events';
import { Checkbox } from '@desktop/components';
import { useMcpServers } from '@desktop/hooks/useMcpServers';
import { agentsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { useWs } from '@desktop/ws/useWs';
import styles from './AgentMcpServers.module.scss';

interface AgentMcpServersProps {
  agentId: string;
  /** Server ids currently enabled for this agent (agent.mcpServers). */
  enabled: string[];
  /** Persist the next enabled list. */
  onSave: (next: string[]) => Promise<void> | void;
}

/**
 * Per-agent MCP enablement. Lists the globally-installed (enabled) MCP servers
 * and lets the operator pick which this agent may use; the agent only sees a
 * server's live tools when it's enabled both globally (here it's filtered to
 * enabled servers) and for the agent.
 */
export const AgentMcpServers: FC<AgentMcpServersProps> = ({ agentId, enabled, onSave }) => {
  // Shared stale-while-revalidate list: refetched on every mount AND on
  // `servers-changed` events, so a server created in the sidebar's MCP view
  // appears here even though this pane stays mounted the whole time (the
  // original bug — re-selecting the same agent never remounts this section).
  const { servers: allServers, loading, revalidate } = useMcpServers();
  const servers = useMemo(() => allServers.filter((s) => s.enabled), [allServers]);
  // Local optimistic state — toggling updates this immediately so the
  // checkbox flips without waiting for the parent re-render triggered by
  // onSave → setAgent. This prevents the pane from jumping during save.
  const [localEnabled, setLocalEnabled] = useState<string[]>(enabled);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Keep local state in sync when the prop changes from outside (e.g. initial
  // load or an external edit) but NOT during in-flight saves. A count, not a
  // flag: with two quick toggles the first save settling must not let its
  // older list replace the second toggle while that save is still running.
  const pendingSaves = useRef(0);
  const savedEnabled = useRef(enabled);
  savedEnabled.current = enabled;
  useEffect(() => {
    if (pendingSaves.current === 0) setLocalEnabled(enabled);
  }, [enabled]);

  // This agent's servers can change outside this pane: another window, the
  // MCP pane's Agents section, or a server deleted or restored (by a person or
  // an agent's `mcp` tool). Each sends `agent.updated` naming `mcpServers`;
  // refetch the agent's list, and the server list since a server may be gone
  // or back. Only the newest refetch lands, and never over an in-flight save.
  const refreshSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    revalidate();
    agentsApi.get(agentId).then(
      (fresh) => {
        if (seq !== refreshSeq.current || pendingSaves.current > 0) return;
        setLocalEnabled(Array.isArray(fresh.mcpServers) ? fresh.mcpServers : []);
      },
      (err: unknown) => {
        console.error('AgentMcpServers: failed to refresh the agent', err);
      }
    );
  }, [agentId, revalidate]);

  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();
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
        if (!isWorkspaceEvent(evt) || evt.type !== 'agent.updated') return;
        if (evt.agentId !== agentId || !evt.changed.includes('mcpServers')) return;
        if (pendingSaves.current > 0) return;
        refresh();
      }),
    [addMessageListener, agentId, refresh]
  );

  const enabledSet = new Set(localEnabled);

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...enabledSet, id] : [...enabledSet].filter((s) => s !== id);
    pendingSaves.current += 1;
    setLocalEnabled(next);
    setSaveError(null);
    // The executor calls onSave synchronously; a throw there rejects too.
    new Promise<void>((resolve) => resolve(onSave(next)))
      .catch((err: unknown) => {
        // Show the last saved list again rather than a choice that did not stick.
        setLocalEnabled(savedEnabled.current);
        setSaveError(getErrorMessage(err, 'Failed to save MCP servers'));
      })
      .finally(() => {
        pendingSaves.current -= 1;
      });
  };

  if (loading) {
    return <p className={styles.mcpHint}>Loading MCP servers…</p>;
  }
  if (servers.length === 0) {
    return (
      <p className={styles.mcpHint}>
        No MCP servers installed. Add one under MCP → Server connections.
      </p>
    );
  }

  return (
    <div className={styles.mcpList}>
      {servers.map((server) => (
        // The Checkbox already renders its own <label>; do NOT wrap it in
        // another one. Nested <label>s both target the same input, so a click
        // toggles it twice (on→off) and the change never sticks. Pass the name
        // and id as children so the whole row stays clickable inside one label.
        <Checkbox
          key={server.id}
          checked={enabledSet.has(server.id)}
          onChange={(next) => toggle(server.id, next)}
        >
          <span className={styles.mcpItemName}>{server.name}</span>
          <span className={styles.mcpItemId}>{server.id}</span>
        </Checkbox>
      ))}
      {saveError && (
        <p className={styles.mcpError} role="alert">
          {saveError}
        </p>
      )}
    </div>
  );
};
