import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { AgentModelEditor, type AgentModelEditorValue } from '@desktop/components/AgentModelEditor';
import { Section } from '@desktop/components';
import { settingsApi, asAgentUtilityModels, asThreadAgentUtilityModels } from '@desktop/utils/api';
import type { UtilityModelRef } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './ChatSettings.module.scss';

interface ThreadUtilityModelOverrideProps {
  threadId: string;
  agentId: string;
  agentName: string;
  /**
   * The agent's effective chat model for this thread (participant override
   * falling back to the agent default) — what "inherit" ultimately resolves
   * to when no agent-level summary model is set.
   */
  agentModel: { providerId: string | null; modelId: string | null };
}

interface SummarySettingsState {
  /** thread id → agent id → ref, as last returned by the server. */
  threadOverrides: Record<string, Record<string, UtilityModelRef>>;
  agentOverrides: Record<string, UtilityModelRef>;
}

/**
 * Per-thread-per-agent summary-model override: an entry in the
 * `agent.thread_summary_model_overrides` JSON map, which beats the agent-level
 * override in this thread only. Saves write only this entry, so edits from
 * other windows are never overwritten. With no override set, the picker shows
 * what "inherit" resolves to: the agent-level summary model, else the agent's
 * own chat model.
 */
export const ThreadUtilityModelOverride: FC<ThreadUtilityModelOverrideProps> = ({
  threadId,
  agentId,
  agentName,
  agentModel,
}) => {
  const [settings, setSettings] = useState<SummarySettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setSettings(null);
    setLoadError(null);
    settingsApi
      .registry()
      .then((records) => {
        if (canceled) return;
        const byKey = (key: string) =>
          records.find((r) => r.category === 'agent' && r.key === key)?.current;
        setSettings({
          threadOverrides: asThreadAgentUtilityModels(byKey('thread_summary_model_overrides')),
          agentOverrides: asAgentUtilityModels(byKey('summary_model_overrides')),
        });
      })
      .catch((err) => {
        if (!canceled) setLoadError(getErrorMessage(err, 'Failed to load summary model'));
      });
    return () => {
      canceled = true;
    };
  }, [threadId, agentId]);

  const override = settings?.threadOverrides[threadId]?.[agentId] ?? null;

  // What "inherit" resolves to right now, mirroring the server chain below
  // the thread override: agent-level override → the agent's own chat model.
  // Purely informational — the resolver decides.
  const inherited = useMemo<{ ref: UtilityModelRef; sourceLabel: string } | null>(() => {
    if (!settings) return null;
    const agentRef = settings.agentOverrides[agentId];
    if (agentRef) return { ref: agentRef, sourceLabel: 'agent setting' };
    if (agentModel.providerId && agentModel.modelId) {
      return {
        ref: { providerId: agentModel.providerId, modelId: agentModel.modelId },
        sourceLabel: 'the agent model',
      };
    }
    return null;
  }, [settings, agentId, agentModel.providerId, agentModel.modelId]);

  const handleSave = useCallback(
    async (next: AgentModelEditorValue) => {
      let saved: unknown;
      if (next.providerId && next.modelId) {
        saved = await settingsApi.putEntry(
          'agent',
          'thread_summary_model_overrides',
          [threadId, agentId],
          { providerId: next.providerId, modelId: next.modelId, credentialId: next.credentialId }
        );
      } else if (!next.providerId && !next.modelId) {
        saved = await settingsApi.deleteEntry('agent', 'thread_summary_model_overrides', [
          threadId,
          agentId,
        ]);
      } else {
        // AgentModelEditor surfaces thrown errors inline next to Save.
        throw new Error('Pick both a provider and a model, or reset to inherit');
      }
      const threadOverrides = asThreadAgentUtilityModels(saved);
      setSettings((prev) => (prev ? { ...prev, threadOverrides } : prev));
    },
    [threadId, agentId]
  );

  if (loadError) {
    return (
      <div className={styles.error} role="alert">
        {loadError}
      </div>
    );
  }
  if (settings === null) {
    return <p className={styles.agentsDetailFieldHelp}>Loading…</p>;
  }

  return (
    <Section
      label="Summary model"
      actions={
        <span className={styles.agentsDetailOverrideTag}>
          {override ? 'overridden' : 'default'}
        </span>
      }
    >
      <p className={styles.agentsDetailFieldHelp}>
        Model for {agentName}'s summaries in this thread only.{' '}
        {override
          ? 'Reset to inherit the agent setting.'
          : inherited
            ? `Inheriting ${inherited.ref.modelId} (${inherited.sourceLabel}).`
            : 'Inheriting the agent setting.'}
      </p>
      <AgentModelEditor
        value={{
          providerId: override?.providerId ?? null,
          modelId: override?.modelId ?? null,
          credentialId: override?.credentialId ?? null,
        }}
        // Prefill the selects with what "inherit" resolves to so the no-override
        // state (and the state right after a reset) displays the inherited
        // provider/model instead of blank fields. Dirty/Reset still key on the
        // raw override value inside the editor, so this never fakes an override.
        fallback={
          inherited
            ? {
                providerId: inherited.ref.providerId,
                modelId: inherited.ref.modelId,
                credentialId: inherited.ref.credentialId ?? null,
              }
            : undefined
        }
        onSave={handleSave}
        allowNull
        emptyOptionLabel={
          inherited
            ? `Default: ${inherited.ref.modelId} (${inherited.sourceLabel})`
            : 'Inherit agent setting'
        }
      />
    </Section>
  );
};
