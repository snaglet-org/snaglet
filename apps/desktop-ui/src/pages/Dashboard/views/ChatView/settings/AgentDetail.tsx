import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { AgentModelEditor } from '@desktop/components/AgentModelEditor';
import { ContextWindowPanel } from '@desktop/components/AgentConfigCard';
import { ToolAccessEditor } from '@desktop/components/ToolAccessEditor';
import { BudgetControl, type BudgetValues } from '@desktop/components/BudgetControl/BudgetControl';
import { Button, Cluster, Section, Stack } from '@desktop/components';
import { threadsApi } from '@desktop/utils/api';
import { ThreadSkillsSection } from '@desktop/features/skills';
import type { ThreadParticipant } from '@desktop/utils/api';
import { useToolOptions, toolAccessOf } from '@desktop/hooks/useToolOptions';
import { type BudgetConfig, type ToolAccessConfig } from '@snaglet/shared/types';
import { getErrorMessage, getInitial } from '@snaglet/shared/utils';
import { isToolAccessEqual } from '@desktop/utils/threadPaneUtils';
import type { AgentEntry } from './settings-types';
import { agentEntryRole } from './threadAgents';
import { InfoHint } from './InfoHint';
import { PromptEditorSection } from './PromptEditorSection';
import { ThreadUtilityModelOverride } from './ThreadUtilityModelOverride';
import styles from './ChatSettings.module.scss';

function compactValues<T extends object>(values: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function participantToToolAccess(p: ThreadParticipant): ToolAccessConfig | null {
  if (!p.toolAccessMode) return null;
  return {
    mode: p.toolAccessMode as ToolAccessConfig['mode'],
    allowList: Array.isArray(p.toolAccessAllowList) ? p.toolAccessAllowList : [],
    denyList: Array.isArray(p.toolAccessDenyList) ? p.toolAccessDenyList : [],
  };
}

function participantToBudget(p: ThreadParticipant): BudgetValues {
  return {
    maxToolCallsPerTurn:
      typeof p.maxToolCallsPerTurn === 'number' ? p.maxToolCallsPerTurn : undefined,
    maxDurationSeconds: typeof p.maxDurationSeconds === 'number' ? p.maxDurationSeconds : null,
  };
}

interface AgentDetailProps {
  entry: AgentEntry;
  threadId: string;
  /** Called after a successful save with the updated participant row. */
  onParticipantUpdated: (next: ThreadParticipant) => void;
  /** Called after this agent is removed from the thread, with its agent id. */
  onParticipantRemoved: (agentId: string) => void;
  /** False hides "Remove from thread" (a DM's membership is fixed). */
  canRemove?: boolean;
}

export const AgentDetail: FC<AgentDetailProps> = ({
  entry,
  threadId,
  onParticipantUpdated,
  onParticipantRemoved,
  canRemove = true,
}) => {
  const { participant, agent } = entry;
  // The saved thread instructions; the editor holds any unsaved draft.
  const [addendumValue, setAddendumValue] = useState(participant.systemPromptAddendum ?? '');
  // Mirrors `addendumValue` from the moment it changes, so a save that
  // starts before the next render still checks against the saved text.
  const savedAddendumRef = useRef(addendumValue);
  const [instructionsConflict, setInstructionsConflict] = useState<string | null>(null);
  const [budgetValue, setBudgetValue] = useState<BudgetValues>({});
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const tools = useToolOptions();

  const adoptSavedAddendum = useCallback((value: string) => {
    savedAddendumRef.current = value;
    setAddendumValue(value);
  }, []);

  // Two-step inline confirm for removing this agent from the thread. The
  // first click arms `confirmRemove`; the second performs the DELETE.
  // Removal is reversible (re-add via the picker), so an inline confirm
  // is enough — no modal.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Reset the confirm affordance whenever the selected participant changes
  // so a primed "Confirm remove" never carries over to a different agent.
  useEffect(() => {
    setConfirmRemove(false);
    setRemoving(false);
    setRemoveError(null);
  }, [participant.agentId, threadId]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await threadsApi.removeParticipant(threadId, participant.agentId);
      // Parent drops the entry and reselects, unmounting this detail — no
      // need to reset local confirm state on the success path.
      onParticipantRemoved(participant.agentId);
    } catch (err) {
      setRemoveError(getErrorMessage(err, 'Failed to remove agent from thread'));
      setRemoving(false);
      setConfirmRemove(false);
    }
  }, [threadId, participant.agentId, onParticipantRemoved]);

  // Reseed the editor when the agent selection changes.
  useEffect(() => {
    if (!agent) return;
    setInstructionsConflict(null);
    adoptSavedAddendum(participant.systemPromptAddendum ?? '');
    setBudgetValue(participantToBudget(participant));
    setBudgetError(null);
  }, [participant.agentId, threadId, agent?.id]);

  const handleSaveModel = useCallback(
    async (next: {
      providerId: string | null;
      modelId: string | null;
      credentialId: string | null;
      disableFallback?: boolean;
    }) => {
      const updated = await threadsApi.setParticipantModel(threadId, participant.agentId, next);
      if (updated) onParticipantUpdated(updated as ThreadParticipant);
    },
    [threadId, participant.agentId, onParticipantUpdated]
  );

  const agentToolAccess = useMemo<ToolAccessConfig>(
    () => (agent ? toolAccessOf(agent) : { mode: 'all', allowList: [], denyList: [] }),
    [agent?.toolAccessMode, agent?.toolAccessAllowList, agent?.toolAccessDenyList]
  );

  const threadToolOverride = useMemo<ToolAccessConfig | null>(
    () => participantToToolAccess(participant),
    [participant]
  );

  const effectiveModel = useMemo(() => {
    const providerId = participant.providerId ?? agent?.provider ?? null;
    const modelId = participant.modelId ?? agent?.modelId ?? null;
    return providerId && modelId ? { providerId, modelId } : null;
  }, [participant.providerId, participant.modelId, agent?.provider, agent?.modelId]);

  const effectiveToolAccess = threadToolOverride ?? agentToolAccess;
  const hasToolOverride = threadToolOverride !== null;

  const handleSaveToolAccess = useCallback(
    async (next: ToolAccessConfig) => {
      const isDefault = isToolAccessEqual(next, agentToolAccess);
      const updated = await threadsApi.updateParticipantOverrides(
        threadId,
        participant.agentId,
        isDefault
          ? { toolAccessMode: null, toolAccessAllowList: null, toolAccessDenyList: null }
          : {
              toolAccessMode: next.mode,
              toolAccessAllowList: next.allowList,
              toolAccessDenyList: next.denyList,
            }
      );
      onParticipantUpdated(updated);
    },
    [threadId, participant.agentId, agentToolAccess, onParticipantUpdated]
  );

  const hasBudgetOverride = useMemo(
    () => participant.maxToolCallsPerTurn != null || participant.maxDurationSeconds != null,
    [participant.maxToolCallsPerTurn, participant.maxDurationSeconds]
  );

  // Saves the values BudgetControl hands over rather than `budgetValue` state:
  // a discrete choice (e.g. "Limited") persists in the same event that sets
  // state, before the re-render that would make the new value visible here.
  const handleSaveBudget = useCallback(
    async (values: BudgetValues) => {
      const cleaned = compactValues(values) as BudgetConfig;
      setBudgetError(null);
      try {
        // Each limit is its own column, so "cleared" is an explicit null per field.
        const updated = await threadsApi.updateParticipantOverrides(threadId, participant.agentId, {
          maxToolCallsPerTurn: cleaned.maxToolCallsPerTurn ?? null,
          maxDurationSeconds:
            typeof values.maxDurationSeconds === 'number' ? values.maxDurationSeconds : null,
        });
        onParticipantUpdated(updated);
      } catch (err) {
        // Show the saved limits again rather than an unsaved choice that
        // looks as if it stuck.
        setBudgetValue(participantToBudget(participant));
        setBudgetError(getErrorMessage(err, 'Failed to save budget'));
      }
    },
    [threadId, participant, onParticipantUpdated]
  );

  const handleSaveAddendum = useCallback(
    async (content: string): Promise<string | void> => {
      const saved = savedAddendumRef.current;
      // Helpers' orchestrators can edit instructions while this pane stays open.
      // Check the saved baseline before writing rather than silently replacing it.
      // On a conflict the editor keeps the draft and adopts the current text as
      // its baseline, so the next Save checks against what is shown.
      if (agent?.parentAgentId) {
        const latest = (await threadsApi.listParticipants(threadId)).find(
          (row) => row.agentId === participant.agentId
        );
        if (!latest) throw new Error('This helper is no longer in the thread. Reopen Settings.');
        if ((latest.systemPromptAddendum ?? '') !== saved) {
          setInstructionsConflict(latest.systemPromptAddendum ?? '');
          onParticipantUpdated(latest);
          adoptSavedAddendum(latest.systemPromptAddendum ?? '');
          throw new Error(
            'Instructions changed since Settings opened. Review the current instructions before saving again.'
          );
        }
      }
      const trimmed = content.trimEnd();
      const updated = await threadsApi.updateParticipantOverrides(threadId, participant.agentId, {
        systemPromptAddendum: trimmed.length === 0 ? null : trimmed,
        ...(agent?.parentAgentId ? { expectedSystemPromptAddendum: saved || null } : {}),
      });
      onParticipantUpdated(updated);
      setInstructionsConflict(null);
      adoptSavedAddendum(trimmed);
      return trimmed;
    },
    [participant.agentId, threadId, onParticipantUpdated, agent?.parentAgentId, adoptSavedAddendum]
  );

  const removeLabel = agent?.name || participant.agentId.slice(0, 8);
  const removeControl = (
    <div className={styles.agentsDetailHeaderActions}>
      {confirmRemove ? (
        <>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleRemove()}
            loading={removing}
            loadingText="Removing…"
          >
            Confirm remove
          </Button>
          <Button
            variant="neutral"
            size="sm"
            onClick={() => setConfirmRemove(false)}
            disabled={removing}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmRemove(true)}
          title={`Remove ${removeLabel} from this thread`}
        >
          Remove from thread
        </Button>
      )}
    </div>
  );
  const hasCustomInstructions = addendumValue.trim().length > 0;
  // A subagent helper lives in its own hidden thread and is removed with it
  // once its orchestrator is done; taking it out by hand would orphan it.
  const isSubagent = Boolean(agent?.parentAgentId);
  const role = agentEntryRole(entry);

  if (!agent) {
    return (
      <div className={styles.agentsDetailMissing}>
        Agent record not found for participant <code>{participant.agentId}</code>. The agent may
        have been deleted while still in this thread.
        {canRemove && removeControl}
        {removeError && (
          <div className={styles.error} role="alert">
            {removeError}
          </div>
        )}
      </div>
    );
  }

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Cluster gap={2} nowrap>
          <span className={styles.agentsDetailAvatar} aria-hidden>
            {getInitial(agent.name)}
          </span>
          <div className={styles.agentsDetailHeading}>
            <h3 className={styles.agentsDetailName}>{agent.name || 'Untitled agent'}</h3>
            {role && <span className={styles.agentsDetailRole}>{role}</span>}
          </div>
        </Cluster>
        {!isSubagent && canRemove && removeControl}
        {removeError && (
          <div className={styles.error} role="alert">
            {removeError}
          </div>
        )}
      </Stack>

      <PromptEditorSection
        label={isSubagent ? 'Instructions' : 'Thread instructions'}
        summary={
          hasCustomInstructions ? 'Custom instructions' : isSubagent ? 'None' : 'Using defaults'
        }
        defaultOpen={isSubagent && hasCustomInstructions}
        hint={
          <InfoHint
            topic={isSubagent ? "the subagent's instructions" : 'thread instructions'}
            text={`Added to ${agent.name || 'this agent'}'s system prompt in this thread. Drag a doc or thread from the sidebar to link it. Click ↳ on a linked doc to transclude it: its full content goes into the prompt at runtime, kept in sync, and shows as a scrollable block. Markdown renders as you type; use / for block commands.`}
          />
        }
        kind="agent-thread-prompt"
        draftScope={`agent-thread-prompt:${threadId}:${participant.agentId}`}
        savedValue={addendumValue}
        onSave={handleSaveAddendum}
      >
        {isSubagent && (
          <p className={styles.agentsDetailFieldHelp}>
            Added to {agent.name}&apos;s system prompt after Snaglet&apos;s own subagent
            instructions, from its next turn.{' '}
            {entry.orchestratorName ?? 'The agent that started it'} can set and change them too.
          </p>
        )}
        {instructionsConflict !== null && (
          <div role="alert">
            <p>
              Instructions changed elsewhere. Your draft has not been saved. Review the current
              instructions below before editing or retrying your draft.
            </p>
            <pre>{instructionsConflict || '(No instructions)'}</pre>
          </div>
        )}
      </PromptEditorSection>

      <Section
        label="Model"
        actions={
          <span className={styles.agentsDetailOverrideTag}>
            {!participant.providerId && !participant.modelId ? 'default' : 'overridden'}
          </span>
        }
      >
        <AgentModelEditor
          value={{
            providerId: participant.providerId ?? null,
            modelId: participant.modelId ?? null,
            credentialId: participant.credentialId ?? null,
            disableFallback: participant.disableFallback,
          }}
          fallback={{
            providerId: agent.provider ?? null,
            modelId: agent.modelId ?? null,
            credentialId: agent.credentialId ?? null,
            disableFallback: agent.disableModelFallback ?? false,
          }}
          onSave={handleSaveModel}
          allowNull
        />
      </Section>

      <ThreadUtilityModelOverride
        threadId={threadId}
        agentId={participant.agentId}
        agentName={agent.name || 'this agent'}
        agentModel={{
          providerId: participant.providerId ?? agent.provider ?? null,
          modelId: participant.modelId ?? agent.modelId ?? null,
        }}
      />

      <Section
        label="Budget"
        actions={
          <span className={styles.agentsDetailOverrideTag}>
            {hasBudgetOverride ? 'overridden' : 'default'}
          </span>
        }
      >
        <p className={styles.agentsDetailFieldHelp}>
          Per-turn limits for {agent.name} on this thread.
          <InfoHint
            topic="budget overrides"
            text="Leave a field empty to inherit the agent default; clearing every field removes the override."
          />
        </p>
        <BudgetControl
          value={budgetValue}
          onChange={setBudgetValue}
          onCommit={(values) => void handleSaveBudget(values)}
          onImmediateChange={(values) => void handleSaveBudget(values)}
        />
        {budgetError && (
          <div className={styles.error} role="alert">
            {budgetError}
          </div>
        )}
      </Section>

      {!isSubagent && (
        <ToolAccessEditor
          value={effectiveToolAccess}
          fallback={agentToolAccess}
          tools={tools}
          onSave={handleSaveToolAccess}
          allowNull
          headerLabel="Tool access"
          headerSlot={
            <span className={styles.agentsDetailOverrideTag}>
              {hasToolOverride ? 'overridden' : 'default'}
            </span>
          }
        />
      )}

      <ThreadSkillsSection
        threadId={threadId}
        agentId={participant.agentId}
        agentName={agent.name}
      />

      <ContextWindowPanel
        threadId={threadId}
        agentId={participant.agentId}
        agentName={agent.name}
        effectiveModel={effectiveModel}
        headerHint={
          <InfoHint
            topic="context window estimates"
            text="A live estimate of system prompt, tool schemas, and recent messages after compression. Token counts use a character-based estimate with a 15–20% margin; the compaction threshold and output reserve come from the model's runtime budget."
          />
        }
      />
    </Stack>
  );
};
