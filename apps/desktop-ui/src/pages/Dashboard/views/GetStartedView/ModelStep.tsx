/**
 * ModelStep — "Choose a model for Patty and Clio" on the Get started pane.
 *
 * Lists each starter agent's model, offers one click on a model (the one an
 * agent with none would take on its first run, or Patty's for Clio), and
 * reuses the agent Overview's model picker. One choice sets every starter
 * agent that has no model or shares Patty's; an agent given its own model on
 * its page keeps it, and each line links to that page. Nothing is saved until
 * the person picks. The step waits, with a hint, until a provider is
 * connected, and is done once every starter agent has a working model.
 *
 * With one starter agent left, the step names only that one. With neither
 * left, it is "Create an agent": it opens the New agent form while there is
 * no other agent, then lists one (the first with a working model, else the
 * first) with a link to its page, and is done once one has a working model.
 */
import { useMemo, useState, type FC } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { getErrorMessage, modelOptionLabels } from '@snaglet/shared/utils';
import type { Provider, ProviderCredential, ProviderDefaultModel } from '@desktop/utils/api';
import { Button } from '@desktop/components/controls/Button/Button';
import { AgentModelEditor, type AgentModelEditorValue } from '@desktop/components/AgentModelEditor';
import { useModelData } from '@desktop/components/ModelSelector/ModelSelector';
import {
  agentModelState,
  fallbackAgent,
  modelOffer,
  modelStepState,
  sharedModelTargets,
  type AgentModelState,
  type ChosenModel,
  type ProviderState,
} from '@desktop/features/onboarding';
import { useDashboardNavigation } from '../../selection/DashboardNavigationContext';
import { STEP_NUMBERS } from './steps';
import styles from './GetStartedView.module.scss';

interface ModelStepProps {
  provider: ProviderState;
  providers: readonly Provider[];
  credentials: readonly ProviderCredential[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  agents: readonly SnagletAgent[];
  /** The other agents, read while no starter agent is left. */
  others: readonly SnagletAgent[];
  suggestion: ProviderDefaultModel | null;
  saveModel: (agentIds: readonly string[], model: ChosenModel) => Promise<void>;
}

/** "Patty", "Patty and Clio". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "Claude Sonnet 5.5 · Anthropic": the model's picker label (its catalog name,
 * with a snapshot date when an alias shares the name), else its id.
 */
function modelLabel(
  providerId: string,
  modelId: string,
  labels: ReadonlyMap<string, string>,
  providers: readonly Provider[],
  suggestion: ProviderDefaultModel | null
): string {
  const suggested =
    suggestion?.providerId === providerId && suggestion.modelId === modelId
      ? suggestion.displayName
      : '';
  const name = labels.get(`${providerId}\u0000${modelId}`) || suggested || modelId;
  return `${name} · ${providers.find((p) => p.id === providerId)?.name ?? providerId}`;
}

function stateText(state: AgentModelState, label: (p: string, m: string) => string): string {
  if (state.kind === 'none') return 'No model yet';
  const text = label(state.providerId, state.modelId);
  return state.kind === 'set' ? text : `${text}, not connected`;
}

export const ModelStep: FC<ModelStepProps> = ({
  provider,
  providers,
  credentials,
  status,
  error: loadError,
  agents,
  others,
  suggestion,
  saveModel,
}) => {
  const nav = useDashboardNavigation();
  // The picker's own model list: read on mount, when the window regains focus,
  // and whenever a provider's catalog changes (models imported in the
  // background after a key is saved arrive as a `models.changed` event).
  const { models } = useModelData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = useMemo(() => {
    const names = modelOptionLabels(models);
    return new Map(models.map((m, i) => [`${m.providerId}\u0000${m.modelId}`, names[i] ?? '']));
  }, [models]);

  const label = (providerId: string, modelId: string) =>
    modelLabel(providerId, modelId, labels, providers, suggestion);
  /** An agent's line: its name, its model and a link to its page. */
  const agentLine = (agent: SnagletAgent, state: AgentModelState) => (
    <li key={agent.id} className={styles.agentRow}>
      <span className={styles.agentName}>{agent.name}</span>
      <span className={styles.agentModel} data-state={state.kind}>
        {stateText(state, label)}
      </span>
      {nav?.openAgentById && (
        <button
          type="button"
          className={styles.link}
          onClick={() => nav.openAgentById?.(agent.id, { tab: 'overview' })}
        >
          {`Open ${agent.name}'s page`}
        </button>
      )}
    </li>
  );

  if (status === 'ready' && agents.length === 0) {
    const listed = fallbackAgent(others, providers, credentials);
    const createState = listed?.state.kind === 'set' ? 'done' : 'open';
    return (
      <section className={styles.step} aria-labelledby="get-started-model" data-state={createState}>
        <div className={styles.stepHead}>
          <span className={styles.stepNumber} aria-hidden>
            {STEP_NUMBERS.model}
          </span>
          <h2 id="get-started-model" className={styles.stepTitle}>
            Create an agent
          </h2>
          <span className={styles.stepState} data-state={createState}>
            {createState === 'done' ? 'Done' : ''}
          </span>
        </div>
        {listed ? (
          <ul className={styles.agentList} aria-label="Agent models">
            {agentLine(listed.agent, listed.state)}
          </ul>
        ) : (
          <>
            <p className={styles.muted}>
              The starter agents were removed. Create an agent, then choose its model on its page.
            </p>
            <div className={styles.actions}>
              <Button variant="primary" size="sm" onClick={() => nav?.openNewAgent?.()}>
                Create an agent
              </Button>
            </div>
          </>
        )}
        {loadError && (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        )}
      </section>
    );
  }

  const states = agents.map((agent) => agentModelState(agent, providers, credentials));
  const stepState = modelStepState(provider, states);
  const targets = sharedModelTargets(agents);
  const lead = targets[0];
  const offer = modelOffer({ agents, providers, credentials, suggestion });
  const nameOf = (ids: readonly string[]) =>
    joinNames(agents.filter((a) => ids.includes(a.id)).map((a) => a.name));
  // Starter agents not read yet (or that could not be read) count as present.
  const who = agents.length > 0 ? joinNames(agents.map((a) => a.name)) : 'Patty and Clio';
  const targetIds = targets.map((a) => a.id);

  const take = async (model: ChosenModel, agentIds: readonly string[]) => {
    setBusy(true);
    setError(null);
    try {
      await saveModel(agentIds, model);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save the model'));
    } finally {
      setBusy(false);
    }
  };

  // The picker shows its own save errors, so a failed save rejects to it.
  const pick = async (next: AgentModelEditorValue) => {
    if (!next.providerId || !next.modelId) return;
    await saveModel(targetIds, {
      providerId: next.providerId,
      modelId: next.modelId,
      credentialId: next.credentialId,
    });
  };

  return (
    <section className={styles.step} aria-labelledby="get-started-model" data-state={stepState}>
      <div className={styles.stepHead}>
        <span className={styles.stepNumber} aria-hidden>
          {STEP_NUMBERS.model}
        </span>
        <h2 id="get-started-model" className={styles.stepTitle}>
          Choose a model for {who}
        </h2>
        <span className={styles.stepState} data-state={stepState === 'done' ? 'done' : 'open'}>
          {stepState === 'done' ? 'Done' : ''}
        </span>
      </div>
      <p className={styles.muted}>
        {agents.length === 1
          ? `Agents think with the model you choose. The choice here sets ${who}'s model; you can change it later on ${who}'s page.`
          : `Agents think with the model you choose. One choice here sets ${who}; to give one of them its own model, open its page.`}
      </p>

      {status !== 'loading' && agents.length > 0 && (
        <ul className={styles.agentList} aria-label="Starter agent models">
          {agents.map((agent, index) => agentLine(agent, states[index] ?? { kind: 'none' }))}
        </ul>
      )}

      {stepState === 'waiting' ? (
        <p className={styles.muted}>Connect a provider in step {STEP_NUMBERS.provider} first.</p>
      ) : (
        lead && (
          <>
            {offer && (
              <div className={styles.offer}>
                <p className={styles.offerText}>
                  {offer.source === 'suggested' ? 'Suggested: ' : `${lead.name} uses `}
                  <strong>{label(offer.providerId, offer.modelId)}</strong>
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void take(offer, offer.agentIds)}
                >
                  {`Use for ${nameOf(offer.agentIds)}`}
                </Button>
              </div>
            )}
            <div className={styles.picker}>
              <p className={styles.label}>{`Model for ${nameOf(targetIds)}`}</p>
              <AgentModelEditor
                value={{
                  providerId: lead.provider || null,
                  modelId: lead.modelId ?? null,
                  credentialId: lead.credentialId ?? null,
                }}
                onSave={pick}
                autosave
              />
            </div>
          </>
        )
      )}

      {(error ?? loadError) && (
        <p className={styles.error} role="alert">
          {error ?? loadError}
        </p>
      )}
    </section>
  );
};
