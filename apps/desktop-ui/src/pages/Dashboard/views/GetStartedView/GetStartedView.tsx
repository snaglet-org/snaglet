/**
 * GetStartedView — the first-run pane: step 1 sets the person's name
 * (NameStep), step 2 connects a model provider through the Providers view's
 * own connect panels, step 3 gives Patty and Clio a model (ModelStep), step 4
 * opens Patty's Onboarding thread once a test has passed. The name never holds
 * up the other steps, and setting it does not end the first run. "Skip for now" lets a person look around first; their
 * thread then says how to connect. Progress is a setting per person
 * (`onboarding.progress`), so the pane picks up where they left off; the model
 * step reads the agents themselves. The steps complete themselves as things
 * get done anywhere.
 *
 * A removed starter agent is not offered: with Patty gone, step 4 greets
 * Clio in her Plan my week thread; with both gone, step 3 creates an agent
 * and step 4 starts a thread with the agents there are (waiting for step 3
 * while there are none), through the Dashboard's own New agent and new thread
 * flows (`helloAction`). A new thread counts as meeting the agents only once
 * it is created.
 */
import { useCallback, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { providersApi, type Provider, type ProviderCredential } from '@desktop/utils/api';
import { Button } from '@desktop/components/controls/Button/Button';
import {
  agentModelState,
  helloAction,
  modelCredentials,
  refreshOnboarding,
  saveOnboardingProgress,
  useOnboarding,
  useStarterAgents,
  type HelloAction,
  type StarterAgentId,
} from '@desktop/features/onboarding';
import { ProvidersView } from '../ProvidersView';
import { useProviderCatalog } from '../ProvidersView/ProviderCatalogContext';
import { useDashboardNavigation } from '../../selection/DashboardNavigationContext';
import type { DetailSelection } from '../../selection/types';
import { PROVIDER_CHOICE_GROUPS, type ProviderChoice } from './providerChoices';
import { ModelStep } from './ModelStep';
import { NameStep } from './NameStep';
import { STEP_NUMBERS } from './steps';
import styles from './GetStartedView.module.scss';

interface GetStartedViewProps {
  /** Open a selection in this pane (Back returns here). */
  onReplaceSelection?: (selection: DetailSelection) => void;
}

/** A test run from this pane: in flight, or its result. */
type TestResult = { status: 'testing' } | { status: 'ok' | 'fail'; message: string };

const STATUS_TEXT: Record<ProviderCredential['verificationStatus'], string> = {
  ok: 'Works',
  untested: 'Not tested yet',
  fail: 'Test failed',
};

/** Help text with each `backticked` span shown as code, such as a command to run. */
function renderHelp(text: string): ReactNode[] {
  return text
    .split('`')
    .map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

/** How the pane introduces each starter agent it can greet. */
const STARTERS: Record<StarterAgentId, { name: string; intro: string; about: string }> = {
  patty: {
    name: 'Patty',
    intro: 'Patty, who can show you around',
    about:
      'Patty is your guide. Ask her anything about Snaglet, or let her help you set up your workspace.',
  },
  clio: {
    name: 'Clio',
    intro: 'Clio, who can plan your week',
    about: 'Clio is your planner: she plans your week, tasks and reminders. Ask her what is next.',
  },
};

/** The header's lead and the last step's heading, text and button. */
function helloText(hello: HelloAction): {
  lead: string;
  title: string;
  about: string;
  button: string;
} {
  if (hello.kind === 'starter') {
    const starter = STARTERS[hello.agentId];
    return {
      lead: `Connect an AI model provider, choose the model your agents use, then meet ${starter.intro}.`,
      title: `Say hello to ${starter.name}`,
      about: starter.about,
      button: `Say hello to ${starter.name}`,
    };
  }
  return {
    lead:
      hello.kind === 'thread'
        ? 'Connect an AI model provider, choose the model your agents use, then start a thread with one of them.'
        : 'Connect an AI model provider, create an agent and choose its model, then start a thread with it.',
    title: 'Start a thread',
    about: 'Pick the agents to talk to and start a thread with them.',
    button: 'Start a thread',
  };
}

/** The person's own label, else the way it connects ("API Key", "GitHub OAuth"). */
function credentialLabel(credential: ProviderCredential, provider: Provider | undefined): string {
  const authName = provider?.authTypes.find((a) => a.id === credential.authTypeId)?.name ?? '';
  const generated = !credential.label || credential.label.includes(credential.authTypeId);
  return generated ? authName : credential.label;
}

export const GetStartedView: FC<GetStartedViewProps> = ({ onReplaceSelection }) => {
  const nav = useDashboardNavigation();
  const onboarding = useOnboarding();
  const { provider, progress, seed } = onboarding;
  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const providersById = useMemo(
    () => new Map(onboarding.providers.map((p) => [p.id, p] as const)),
    [onboarding.providers]
  );
  const connected = useMemo(
    () => modelCredentials(onboarding.providers, onboarding.credentials),
    [onboarding.providers, onboarding.credentials]
  );
  const groups = useMemo(
    () =>
      PROVIDER_CHOICE_GROUPS.map((group) => ({
        ...group,
        choices: group.choices.filter((choice) => providersById.has(choice.providerId)),
      })).filter((group) => group.choices.length > 0),
    [providersById]
  );
  const chosen = useMemo<{ choice: ProviderChoice; provider: Provider } | null>(() => {
    for (const group of groups) {
      const choice = group.choices.find((c) => c.key === choiceKey);
      const target = choice ? providersById.get(choice.providerId) : undefined;
      if (choice && target) return { choice, provider: target };
    }
    return null;
  }, [choiceKey, groups, providersById]);

  const test = useCallback(async (credentialId: string) => {
    setTests((prev) => ({ ...prev, [credentialId]: { status: 'testing' } }));
    try {
      const result = await providersApi.retestCredential(credentialId);
      setTests((prev) => ({
        ...prev,
        [credentialId]: { status: result.valid ? 'ok' : 'fail', message: result.message },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [credentialId]: { status: 'fail', message: getErrorMessage(err, 'Test failed') },
      }));
    }
    await refreshOnboarding();
  }, []);

  // A key saved here is tested at once, so the person sees whether it works.
  const knownIds = useRef<Set<string> | null>(null);
  if (knownIds.current === null && onboarding.status === 'ready') {
    knownIds.current = new Set(onboarding.credentials.map((c) => c.id));
  }
  const onCredentialsChanged = useCallback(
    (credentials: ProviderCredential[]) => {
      const known = knownIds.current ?? new Set<string>();
      knownIds.current = new Set(credentials.map((c) => c.id));
      void refreshOnboarding();
      const added = credentials.filter(
        (c) => !known.has(c.id) && providersById.get(c.providerId)?.type === 'llm'
      );
      // The new key's result shows under Connected, so the panel can close.
      if (added.length > 0) setChoiceKey(null);
      for (const credential of added) {
        if (credential.verificationStatus === 'untested') void test(credential.id);
      }
    },
    [providersById, test]
  );
  const onVerified = useCallback((providerId: string) => {
    void saveOnboardingProgress({
      providerReadyAt: new Date().toISOString(),
      providerId,
    }).catch((err: unknown) => setActionError(getErrorMessage(err)));
  }, []);

  // Connecting a provider, a key's test result or an imported model can change
  // what the model step offers, and its picker reads the model list on mount.
  const catalogModels = useProviderCatalog().models.length;
  const revision = `${provider.kind}|${connected
    .map((c) => `${c.id}:${c.verificationStatus}`)
    .join(',')}|${catalogModels}`;
  const starters = useStarterAgents(revision);
  const suggested = starters.suggestion;
  const modelStepKey = `${revision}|${suggested ? `${suggested.providerId}/${suggested.modelId}` : ''}`;

  const clioThreadId = seed?.threads?.clio ?? null;
  const welcomeDocId = seed?.docs?.['welcome-to-snaglet'] ?? null;
  const startersRead = starters.status === 'ready';
  const hello = useMemo(
    () =>
      helloAction({
        starters: startersRead ? starters.agents : null,
        others: starters.others,
        seed,
      }),
    [startersRead, starters.agents, starters.others, seed]
  );
  const text = helloText(hello);

  /** The greeted starter agent's thread here (Patty's with the Welcome doc beside it), else its page. */
  const openStarter = useCallback(() => {
    if (hello.kind !== 'starter') return;
    if (hello.threadId && onReplaceSelection) {
      onReplaceSelection({ kind: 'thread', thread_id: hello.threadId });
      if (hello.agentId === 'patty' && welcomeDocId) {
        nav?.openBeside?.({ kind: 'doc', doc_id: welcomeDocId });
      }
    } else {
      nav?.openAgentById?.(hello.agentId);
    }
  }, [hello, nav, onReplaceSelection, welcomeDocId]);

  const recordHello = useCallback(() => {
    void saveOnboardingProgress({ pattyOpenedAt: new Date().toISOString() }).catch((err: unknown) =>
      setActionError(getErrorMessage(err))
    );
  }, []);

  // A starter's thread opens at once; a new thread counts only once it is created.
  const sayHello = useCallback(() => {
    setActionError(null);
    if (hello.kind === 'thread') {
      nav?.openNewThread?.(recordHello);
    } else if (hello.kind === 'starter') {
      recordHello();
      openStarter();
    }
  }, [hello.kind, nav, openStarter, recordHello]);

  const skip = useCallback(() => {
    setActionError(null);
    void saveOnboardingProgress({ providerSkippedAt: new Date().toISOString() }).catch(
      (err: unknown) => setActionError(getErrorMessage(err))
    );
    openStarter();
  }, [openStarter]);

  const ready = provider.kind === 'ready';
  const readyName = ready ? (providersById.get(provider.providerId)?.name ?? null) : null;
  // Say hello points back at the model step while the greeted agent has no working model.
  const greeted =
    hello.kind === 'starter'
      ? starters.agents.find((agent) => agent.id === hello.agentId)
      : undefined;
  const needsModel =
    ready &&
    greeted !== undefined &&
    agentModelState(greeted, onboarding.providers, connected).kind !== 'set'
      ? greeted.name
      : null;
  // Clio is offered beside Patty until a read shows she is gone.
  const clioGone = startersRead && !starters.agents.some((agent) => agent.id === 'clio');
  const offersClio = hello.kind === 'starter' && hello.agentId === 'patty' && !clioGone;

  if (onboarding.status === 'loading') {
    return (
      <div className={styles.shell}>
        <p className={styles.muted}>Loading…</p>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Get started</p>
          <h1 className={styles.title}>Welcome to Snaglet</h1>
          <p className={styles.lead}>
            {text.lead}
            {welcomeDocId && (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => onReplaceSelection?.({ kind: 'doc', doc_id: welcomeDocId })}
                >
                  Read the welcome guide
                </button>
              </>
            )}
          </p>
          {onboarding.status === 'error' && onboarding.error && (
            <p className={styles.error} role="alert">
              {onboarding.error}{' '}
              <button
                type="button"
                className={styles.link}
                onClick={() => void refreshOnboarding()}
              >
                Try again
              </button>
            </p>
          )}
        </header>

        <NameStep />

        <section className={styles.step} aria-labelledby="get-started-provider">
          <div className={styles.stepHead}>
            <span className={styles.stepNumber} aria-hidden>
              {STEP_NUMBERS.provider}
            </span>
            <h2 id="get-started-provider" className={styles.stepTitle}>
              Connect a provider
            </h2>
            <span className={styles.stepState} data-state={ready ? 'done' : 'open'}>
              {ready
                ? `Done${readyName ? ` · ${readyName}` : ''}`
                : progress.providerSkippedAt
                  ? 'Skipped'
                  : ''}
            </span>
          </div>
          <p className={styles.muted}>
            Agents need an AI model to reply. Pick how you want to connect; you can add more later
            in Providers.
          </p>

          {connected.length > 0 && (
            <div className={styles.connected}>
              <p className={styles.label}>Connected</p>
              <ul className={styles.connectedList}>
                {connected.map((credential) => {
                  const result = tests[credential.id];
                  const testing = result?.status === 'testing';
                  const status =
                    result && result.status !== 'testing'
                      ? result.status
                      : credential.verificationStatus;
                  const message = result && result.status !== 'testing' ? result.message : null;
                  return (
                    <li key={credential.id} className={styles.connectedRow}>
                      <span className={styles.connectedName}>
                        {providersById.get(credential.providerId)?.name ?? credential.providerId}
                      </span>
                      <span className={styles.connectedLabel}>
                        {credentialLabel(credential, providersById.get(credential.providerId))}
                      </span>
                      <span
                        className={styles.connectedStatus}
                        data-status={testing ? 'testing' : status}
                        role="status"
                      >
                        {testing ? 'Testing…' : STATUS_TEXT[status]}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={testing}
                        onClick={() => void test(credential.id)}
                      >
                        Test connection
                      </Button>
                      {message && status === 'fail' && (
                        <p className={styles.connectedReason}>{message}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.id} className={styles.group}>
              <p className={styles.label}>{group.label}</p>
              <ul className={styles.cards}>
                {group.choices.map((choice) => {
                  const active = choice.key === choiceKey;
                  return (
                    <li key={choice.key}>
                      <button
                        type="button"
                        className={styles.card}
                        data-active={active || undefined}
                        aria-pressed={active}
                        onClick={() => setChoiceKey(active ? null : choice.key)}
                      >
                        <span className={styles.cardTitle}>{choice.title}</span>
                        <span className={styles.cardBlurb}>{choice.blurb}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {chosen && group.choices.some((c) => c.key === chosen.choice.key) && (
                <div className={styles.connect}>
                  <p className={styles.help}>{renderHelp(chosen.choice.help(chosen.provider))}</p>
                  <div className={styles.embed}>
                    <ProvidersView
                      key={chosen.provider.id}
                      providerId={chosen.provider.id}
                      hideModels={!chosen.choice.showModels}
                      connectVia={chosen.choice.connectVia}
                      onVerified={onVerified}
                      onCredentialsChanged={onCredentialsChanged}
                    />
                  </div>
                </div>
              )}
              {group.note && <p className={styles.note}>{group.note}</p>}
            </div>
          ))}

          {!ready && !progress.providerSkippedAt && (
            <button type="button" className={styles.skip} onClick={skip}>
              Skip for now
            </button>
          )}
        </section>

        <ModelStep
          key={modelStepKey}
          provider={provider}
          providers={onboarding.providers}
          credentials={connected}
          {...starters}
        />

        <section className={styles.step} aria-labelledby="get-started-patty">
          <div className={styles.stepHead}>
            <span className={styles.stepNumber} aria-hidden>
              {STEP_NUMBERS.hello}
            </span>
            <h2 id="get-started-patty" className={styles.stepTitle}>
              {text.title}
            </h2>
            <span
              className={styles.stepState}
              data-state={progress.pattyOpenedAt ? 'done' : 'open'}
            >
              {progress.pattyOpenedAt ? 'Done' : ''}
            </span>
          </div>
          <p className={styles.muted}>{text.about}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              size="md"
              disabled={!ready || hello.kind === 'create'}
              onClick={sayHello}
            >
              {text.button}
            </Button>
            {hello.kind === 'create' ? (
              <span className={styles.muted}>
                Create an agent in step {STEP_NUMBERS.model} first.
              </span>
            ) : (
              !ready && <span className={styles.muted}>Connect a provider first.</span>
            )}
            {needsModel && (
              <span className={styles.muted}>
                Choose {needsModel}&apos;s model in step {STEP_NUMBERS.model} first.
              </span>
            )}
          </div>
          {progress.pattyOpenedAt && clioThreadId && offersClio && (
            <p className={styles.muted}>
              Clio is ready too: she plans your week, tasks and reminders.{' '}
              <button
                type="button"
                className={styles.link}
                onClick={() => onReplaceSelection?.({ kind: 'thread', thread_id: clioThreadId })}
              >
                Open Plan my week
              </button>
            </p>
          )}
          {actionError && (
            <p className={styles.error} role="alert">
              {actionError}
            </p>
          )}
        </section>
      </div>
    </div>
  );
};
