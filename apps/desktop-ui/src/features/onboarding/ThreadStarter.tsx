/**
 * What an empty thread with agents shows: who to say hello to, a few things
 * to ask, and, while no provider works, how to connect one. A suggestion only
 * fills the composer; nothing is sent until the person sends it.
 */
import { type FC } from 'react';
import { Button } from '@desktop/components/controls/Button/Button';
import { needsProviderBanner } from './onboardingModel';
import { useOnboarding } from './useOnboarding';
import styles from './ThreadStarter.module.scss';

/** Things to ask each starter agent; any other agent gets the generic set. */
const SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  patty: ['What can you help me set up?', 'Show me around', 'Help me organize my notes'],
  clio: [
    'Add a reminder for tomorrow at 9',
    'Make a weekly plan',
    'What is on my calendar this week?',
  ],
};
const GENERIC_SUGGESTIONS = ['What can you help me with?', 'Introduce yourself'];
/**
 * The first suggestion: the way into the product for a new person. Patty
 * guides onboarding, so a thread with only the planner does not offer it.
 */
const GET_STARTED_SUGGESTION = 'Help me get started';
const PLANNER_ONLY = new Set(['clio']);
const MAX_SUGGESTIONS = 4;

function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Suggestions for the thread's agents, the starter agents' own first. */
function threadSuggestions(agentIds: readonly string[]): string[] {
  const picked = agentIds.flatMap((id) => SUGGESTIONS[id] ?? []);
  const rest = picked.length > 0 ? picked : GENERIC_SUGGESTIONS;
  const plannerOnly = agentIds.length > 0 && agentIds.every((id) => PLANNER_ONLY.has(id));
  const lead = plannerOnly ? [] : [GET_STARTED_SUGGESTION];
  return [...new Set([...lead, ...rest])].slice(0, MAX_SUGGESTIONS);
}

interface ProviderNoticeProps {
  /** Display names of the thread's agents. */
  agentNames: readonly string[];
  /** Open the Get started pane. */
  onConnect: () => void;
}

/** "Connect a provider so … can reply", while nothing connected works. */
export const ProviderNotice: FC<ProviderNoticeProps> = ({ agentNames, onConnect }) => {
  const { status, provider } = useOnboarding();
  if (status !== 'ready' || !needsProviderBanner(provider)) return null;
  const who = names(agentNames) || 'agents';
  return (
    <div className={styles.notice} role="status">
      <span>
        {provider.kind === 'none'
          ? `Connect a provider so ${who} can reply.`
          : `Your provider's last test failed, so ${who} can't reply yet.`}
      </span>
      <Button variant="neutral" size="sm" onClick={onConnect}>
        {provider.kind === 'none' ? 'Connect a provider' : 'Fix the connection'}
      </Button>
    </div>
  );
};

interface ThreadStarterProps {
  agentIds: readonly string[];
  agentNames: readonly string[];
  /** Put this text in the composer. */
  onPick: (text: string) => void;
}

export const ThreadStarter: FC<ThreadStarterProps> = ({ agentIds, agentNames, onPick }) => {
  const suggestions = threadSuggestions(agentIds);
  const who = names(agentNames);
  return (
    <div className={styles.starter}>
      <p className={styles.title}>{who ? `Say hello to ${who}` : 'Say hello'}</p>
      <p className={styles.hint}>Type a message below, or start with one of these.</p>
      <div className={styles.chips}>
        {suggestions.map((text) => (
          <button key={text} type="button" className={styles.chip} onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
};
