import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { AgentModelEditor, type AgentModelEditorValue } from '@desktop/components/AgentModelEditor';
import { settingsApi, asAgentUtilityModels, agentsApi } from '@desktop/utils/api';
import type { UtilityModelRef } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_EVENT_CHANNEL,
  type SettingsChangedEvent,
  type WsMessage,
} from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL, isWorkspaceEvent } from '@snaglet/shared/types/workspace-events';
import { useWs } from '@desktop/ws/useWs';
import styles from './AgentUtilityModelOverride.module.scss';

interface AgentUtilityModelOverrideProps {
  agentId: string;
}

/** The agent's own main-model triple — what "no override" resolves to. */
interface InheritedAgentModel {
  providerId: string | null;
  modelId: string | null;
  credentialId: string | null;
}

/**
 * Per-agent summary-model override: one entry in the map-valued
 * `agent.summary_model_overrides` setting (agent ids can't be settings keys).
 * An entry beats the agent's own model for its thread summaries; with none,
 * the agent summarizes with its own model. A save writes only this agent's
 * entry, so edits from other windows survive; "Reset to default" removes it.
 * The agent's main model is fetched here and passed as `fallback`, so the
 * selects always show what the default resolves to; `agent.updated` for this
 * agent refetches it. The override map is reread when the setting changes
 * anywhere else (`settings:changed`, e.g. another window or an agent's tool)
 * and after a reconnect; a reread that a save overtook is dropped.
 */
export const AgentUtilityModelOverride: FC<AgentUtilityModelOverrideProps> = ({ agentId }) => {
  const [overrides, setOverrides] = useState<Record<string, UtilityModelRef> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentModel, setAgentModel] = useState<InheritedAgentModel | null>(null);
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();

  // Counts saves started, so a reread that a save overtook is dropped.
  const savesRef = useRef(0);
  const loadSeq = useRef(0);
  const loadOverrides = useCallback(async (initial: boolean) => {
    const seq = ++loadSeq.current;
    const savesAtStart = savesRef.current;
    try {
      const records = await settingsApi.registry();
      if (seq !== loadSeq.current || savesRef.current !== savesAtStart) return;
      const record = records.find(
        (r) => r.category === 'agent' && r.key === 'summary_model_overrides'
      );
      setOverrides(asAgentUtilityModels(record?.current));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (initial) setLoadError(getErrorMessage(err, 'Failed to load utility model override'));
      else console.error('AgentUtilityModelOverride: failed to reread the override', err);
    }
  }, []);

  useEffect(() => {
    setOverrides(null);
    setLoadError(null);
    void loadOverrides(true);
    return () => {
      // A load still running for the previous agent must not land.
      loadSeq.current += 1;
    };
  }, [agentId, loadOverrides]);

  // The override is a setting: follow `settings:changed` for it, and reread
  // after a reconnect (frames sent while the socket was down are lost).
  const wasOpen = useRef(connectionState === 'open');
  useEffect(() => {
    if (connectionState !== 'open') {
      wasOpen.current = false;
      return;
    }
    if (!wasOpen.current) void loadOverrides(false);
    wasOpen.current = true;
    subscribe(SETTINGS_EVENT_CHANNEL);
    return () => unsubscribe(SETTINGS_EVENT_CHANNEL);
  }, [connectionState, loadOverrides, subscribe, unsubscribe]);
  useEffect(
    () =>
      addMessageListener((message: WsMessage) => {
        if (message.channel !== SETTINGS_EVENT_CHANNEL || message.type !== SETTINGS_CHANGED_EVENT) {
          return;
        }
        const change = message.payload as Partial<SettingsChangedEvent> | null;
        if (change?.category === 'agent' && change.key === 'summary_model_overrides') {
          void loadOverrides(false);
        }
      }),
    [addMessageListener, loadOverrides]
  );

  // The inherited default. Failure is non-fatal — the override editor still
  // works; only the inherited prefill is missing (fields fall back to blank).
  const refreshAgentModel = useCallback(async () => {
    try {
      const agent = await agentsApi.get(agentId);
      setAgentModel({
        providerId: agent.provider || null,
        modelId: agent.modelId ?? null,
        credentialId: agent.credentialId ?? null,
      });
    } catch (err) {
      console.error('AgentUtilityModelOverride: failed to load agent model', err);
    }
  }, [agentId]);

  useEffect(() => {
    setAgentModel(null);
    void refreshAgentModel();
  }, [refreshAgentModel]);

  // Workspace channel subscription (holder-counted, mirrors useWsChannel):
  // `agent.updated` is an invalidation signal — refetch the canonical row.
  useEffect(() => {
    subscribe(WORKSPACE_EVENT_CHANNEL);
    return () => unsubscribe(WORKSPACE_EVENT_CHANNEL);
  }, [subscribe, unsubscribe]);
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
        if (!isWorkspaceEvent(evt) || evt.type !== 'agent.updated' || evt.agentId !== agentId) {
          return;
        }
        void refreshAgentModel();
      }),
    [addMessageListener, agentId, refreshAgentModel]
  );

  const handleSave = useCallback(
    async (next: AgentModelEditorValue) => {
      savesRef.current += 1;
      let saved: unknown;
      if (next.providerId && next.modelId) {
        saved = await settingsApi.putEntry('agent', 'summary_model_overrides', [agentId], {
          providerId: next.providerId,
          modelId: next.modelId,
          credentialId: next.credentialId,
        });
      } else if (!next.providerId && !next.modelId) {
        saved = await settingsApi.deleteEntry('agent', 'summary_model_overrides', [agentId]);
      } else {
        // AgentModelEditor surfaces thrown errors inline next to Save.
        throw new Error('Pick both a provider and a model, or reset the override');
      }
      setOverrides(asAgentUtilityModels(saved));
    },
    [agentId]
  );

  if (loadError) {
    return (
      <div className={styles.error} role="alert">
        {loadError}
      </div>
    );
  }
  if (overrides === null) {
    return <div className={styles.hint}>Loading…</div>;
  }

  const override = overrides[agentId] ?? null;
  return (
    <div>
      <p className={styles.description}>
        Model for this agent&rsquo;s thread summaries.{' '}
        {override
          ? 'Overriding the agent model — reset to inherit it.'
          : agentModel?.modelId
            ? `Inheriting ${agentModel.modelId} from the agent model.`
            : 'Default: the model the agent is on.'}
      </p>
      {/* autosave keeps AgentView's "no manual Save button" contract: a
          chosen model persists immediately; "Reset to default" removes the
          override entry. */}
      <AgentModelEditor
        value={{
          providerId: override?.providerId ?? null,
          modelId: override?.modelId ?? null,
          credentialId: override?.credentialId ?? null,
        }}
        fallback={
          agentModel
            ? {
                providerId: agentModel.providerId,
                modelId: agentModel.modelId,
                credentialId: agentModel.credentialId,
              }
            : undefined
        }
        onSave={handleSave}
        allowNull
        emptyOptionLabel="Same as agent model"
        autosave
      />
    </div>
  );
};
