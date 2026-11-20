/**
 * New automation, from the Automations pane: who wakes (an agent), where (a
 * thread that agent is in), what they are told, and when. Agent and thread
 * are one-chip pickers (search, paste an id or link, or drop from the
 * sidebar) and the prompt is the composer's chip editor. Saved through
 * POST /api/automations as a person, so any agent and thread may be picked;
 * the server still requires the agent to be in the thread, so the form checks
 * that first and says so in the server's words. Times are in this computer's
 * zone. It goes on the Default calendar unless another (or No calendar) is
 * picked, whatever its timing.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  type AutomationRecord,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, TextInput } from '@desktop/components';
import { FetchError, threadsApi } from '@desktop/utils/api';
import { automationsApi } from '@desktop/utils/api/automations';
import { AutomationCalendarField, useAutomationCalendars } from './AutomationCalendarPicker';
import { AutomationChipPicker, threadIdFromText, type ChipPick } from './AutomationChipPicker';
import { AutomationPromptField, promptLength } from './AutomationPromptField';
import { AutomationTimingFields, useAutomationTiming } from './AutomationTimingFields';
import styles from './AutomationEditForm.module.scss';

export interface AutomationCreateFormProps {
  onCreated: (automation: AutomationRecord) => void;
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function resolveThread(id: string): Promise<ChipPick> {
  try {
    const thread = await threadsApi.get(id);
    return { id: thread.id, title: thread.title ?? 'Untitled thread' };
  } catch (err) {
    if (err instanceof FetchError && err.status === 404) {
      throw new Error(`Thread ${id} not found.`);
    }
    throw err;
  }
}

/** Whether the agent is in the thread, for one agent + thread pair. */
interface Membership {
  key: string;
  /** `unknown`: the check failed, so the server decides. */
  status: 'checking' | 'in' | 'out' | 'unknown';
}

export function AutomationCreateForm({ onCreated }: AutomationCreateFormProps) {
  const timing = useAutomationTiming(null, localZone());
  const [agent, setAgent] = useState<ChipPick | null>(null);
  const [thread, setThread] = useState<ChipPick | null>(null);
  // How many threads the agent is in (0, 1, or more), for the hint and the
  // one-thread shortcut; null until known.
  const [agentThreadCount, setAgentThreadCount] = useState<number | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const { calendars, defaultId, loaded } = useAutomationCalendars();
  // undefined until picked (the Default calendar); null = No calendar.
  const [calendarPick, setCalendarPick] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing picked: the Default calendar (left to the server until the list loads).
  const calendarChoice =
    calendarPick === undefined && !defaultId
      ? {}
      : { calendarId: calendarPick === undefined ? defaultId : calendarPick };

  const agentId = agent?.id ?? null;
  const threadId = thread?.id ?? null;
  // The thread as of the last render, and the one the form filled in itself
  // (null once the person picks one).
  const threadRef = useRef(thread);
  const filledThreadId = useRef<string | null>(null);
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  const pickThread = (next: ChipPick | null) => {
    filledThreadId.current = null;
    setThread(next);
  };

  // A new agent: fill in its thread when it is in exactly one. A thread filled
  // in for the agent before goes unless this one is in it too; one the person
  // picked stays (the membership check speaks for it).
  useEffect(() => {
    setAgentThreadCount(null);
    if (!agentId) return;
    let alive = true;
    threadsApi
      .list(agentId)
      .then((rows) => {
        if (!alive) return;
        setAgentThreadCount(rows.length);
        const current = threadRef.current;
        const keep =
          current !== null &&
          (current.id !== filledThreadId.current || rows.some((row) => row.id === current.id));
        if (keep) return;
        const only = rows.length === 1 ? rows[0] : undefined;
        const next = only ? { id: only.id, title: only.title ?? 'Untitled thread' } : null;
        filledThreadId.current = next?.id ?? null;
        if (next || current) setThread(next);
      })
      .catch((err: unknown) => {
        // Only the shortcut and the hint need this list; picking still works.
        console.warn(`[automations] couldn't list ${agentId}'s threads: ${getErrorMessage(err)}`);
      });
    return () => {
      alive = false;
    };
  }, [agentId]);

  // The agent must be in the thread; re-checked whenever either changes.
  const pairKey = agentId && threadId ? `${agentId} ${threadId}` : null;
  useEffect(() => {
    if (!agentId || !threadId) return;
    const key = `${agentId} ${threadId}`;
    let alive = true;
    setMembership({ key, status: 'checking' });
    threadsApi
      .listParticipants(threadId)
      .then((participants) => {
        if (!alive) return;
        const inThread = participants.some((p) => p.agentId === agentId);
        setMembership({ key, status: inThread ? 'in' : 'out' });
      })
      .catch(() => {
        if (alive) setMembership({ key, status: 'unknown' });
      });
    return () => {
      alive = false;
    };
  }, [agentId, threadId]);

  const pairStatus = membership && membership.key === pairKey ? membership.status : null;
  const notInThread = pairStatus === 'out';
  const length = promptLength(prompt);
  const valid =
    agent !== null &&
    thread !== null &&
    (pairStatus === 'in' || pairStatus === 'unknown') &&
    name.trim().length > 0 &&
    name.trim().length <= AUTOMATION_NAME_MAX_LENGTH &&
    length > 0 &&
    length <= AUTOMATION_PROMPT_MAX_LENGTH &&
    timing.valid;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const when = timing.input();
    if (!valid || saving || !when || !agent || !thread) return;
    setSaving(true);
    setError(null);
    try {
      const { automation } = await automationsApi.create({
        name: name.trim(),
        prompt: prompt.trim(),
        when,
        agentId: agent.id,
        threadId: thread.id,
        ...calendarChoice,
      });
      onCreated(automation);
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't create the automation"));
      setSaving(false);
    }
  };

  const threadHint =
    agent && agentThreadCount === 0 && !thread
      ? `${agent.title} isn't in any thread yet. Add them to one first.`
      : 'Where the agent wakes up and works. Search, paste its id or link, or drag one in.';

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={styles.inlineForm}
      aria-label="New automation"
    >
      <div className={styles.fields}>
        <AutomationChipPicker
          kind="agent"
          label="Agent"
          value={agent}
          onChange={setAgent}
          placeholder="Type to find an agent…"
          hint="Who wakes up."
          disabled={saving}
        />
        <AutomationChipPicker
          kind="thread"
          label="Thread"
          value={thread}
          onChange={pickThread}
          resolve={resolveThread}
          idFromText={threadIdFromText}
          placeholder="Type to find a thread…"
          hint={threadHint}
          problem={notInThread && agent ? `${agent.title} isn't in that thread.` : null}
          disabled={saving}
        />
        <TextInput
          label="Name"
          value={name}
          maxLength={AUTOMATION_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning check-in"
          fullWidth
          disabled={saving}
        />
        <AutomationPromptField
          value={prompt}
          onChange={setPrompt}
          agentName={agent?.title}
          disabled={saving}
        />
        <AutomationTimingFields timing={timing} />
        <AutomationCalendarField
          value={calendarPick}
          onChange={setCalendarPick}
          calendars={calendars}
          loaded={loaded}
          disabled={saving}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={styles.footer}>
        <Button type="submit" variant="primary" size="sm" disabled={!valid || saving}>
          {saving ? 'Creating…' : 'Create automation'}
        </Button>
      </div>
    </form>
  );
}
