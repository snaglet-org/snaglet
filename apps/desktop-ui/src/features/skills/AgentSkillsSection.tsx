import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { skillsApi, type SkillInfo } from '@desktop/utils/api/skills';
import { subscribeAgentEvents } from '@desktop/utils/agentEvents';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { SkillPicker } from './SkillPicker';
import styles from './skills.module.scss';

export const NEXT_RUN_HELP = 'Changes apply from the agent’s next run.';

/** Link that opens the Skills sidebar view (no-op outside the dashboard). */
const OpenSkillsViewLink: FC<{ children: string }> = ({ children }) => {
  const nav = useDashboardNavigation();
  if (!nav) return <>{children}</>;
  return (
    <button
      type="button"
      className={styles.linkBtn}
      onClick={() => nav.requestReveal('', 'skills')}
    >
      {children}
    </button>
  );
};

/** Registry list for a picker; refreshed whenever the section mounts. */
export function useSkillList(): {
  skills: SkillInfo[] | null;
  error: string | null;
} {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    skillsApi
      .list()
      .then((rows) => alive && setSkills(rows))
      .catch((e: unknown) => alive && setError(getErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, []);
  return { skills, error };
}

export interface AgentSkillsSectionProps {
  agentId: string;
  /** The saved skills changed somewhere else (an agent's tool, another window). */
  onRemoteChange?: () => void;
}

const sameSkills = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * The agent’s general skills: a searchable add-dropdown that
 * saves on every add or remove. Self-contained so it can move into the Tools tab when
 * the three-tab agent editor lands.
 *
 * Live while mounted: `agent.updated` naming `skills` for this agent, or a
 * reconnect, rereads the list. A save of its own waits out the reread, so its
 * echo never reads as someone else's change.
 */
export const AgentSkillsSection: FC<AgentSkillsSectionProps> = ({ agentId, onRemoteChange }) => {
  const { skills, error: listError } = useSkillList();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef<string[] | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const savingRef = useRef(false);
  // A reread was asked for while a save ran: do it once the save is done.
  const rereadAfterSave = useRef(false);
  // Only the newest reread lands, and only if no save started since it began.
  const rereadSeq = useRef(0);
  const savesStarted = useRef(0);
  const onRemoteChangeRef = useRef(onRemoteChange);
  onRemoteChangeRef.current = onRemoteChange;

  useEffect(() => {
    let alive = true;
    setSelected(null);
    skillsApi
      .agentSkills(agentId)
      .then((r) => alive && setSelected(r.skillIds))
      .catch((e: unknown) => alive && setError(getErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, [agentId]);

  const reread = useCallback(() => {
    if (savingRef.current) {
      rereadAfterSave.current = true;
      return;
    }
    const seq = ++rereadSeq.current;
    const savesAtStart = savesStarted.current;
    skillsApi
      .agentSkills(agentId)
      .then((r) => {
        if (seq !== rereadSeq.current) return;
        if (savesStarted.current !== savesAtStart) {
          // A save overtook this read: read again once it is done.
          if (savingRef.current) rereadAfterSave.current = true;
          else reread();
          return;
        }
        const shown = selectedRef.current;
        if (shown === null || sameSkills(shown, r.skillIds)) return;
        setSelected(r.skillIds);
        onRemoteChangeRef.current?.();
      })
      .catch((e: unknown) => {
        console.error('AgentSkillsSection: failed to reread skills', e);
      });
  }, [agentId]);

  useEffect(
    () =>
      subscribeAgentEvents((event) => {
        if (event.type === 'agents.invalidated') reread();
        else if (event.agentId === agentId && event.changed.includes('skills')) reread();
      }),
    [agentId, reread]
  );

  const save = useCallback(
    async (next: string[]) => {
      const previous = selected;
      setSelected(next);
      latest.current = next;
      setSaving(true);
      savingRef.current = true;
      savesStarted.current += 1;
      setError(null);
      try {
        const saved = await skillsApi.setAgentSkills(agentId, next);
        if (latest.current === next) setSelected(saved.skillIds);
      } catch (e) {
        if (latest.current === next) setSelected(previous);
        setError(getErrorMessage(e));
      } finally {
        setSaving(false);
        savingRef.current = false;
        if (rereadAfterSave.current) {
          rereadAfterSave.current = false;
          reread();
        }
      }
    },
    [agentId, selected, reread]
  );

  if (listError) return <p className={styles.error}>Could not load skills: {listError}</p>;
  if (!skills || !selected) {
    return error ? (
      <p className={styles.error}>{error}</p>
    ) : (
      <p className={styles.hint}>Loading skills…</p>
    );
  }
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>Skills this agent can load in every thread. {NEXT_RUN_HELP}</p>
      <SkillPicker
        skills={skills}
        selected={selected}
        onChange={(next) => void save(next)}
        disabled={saving}
        label="Agent skills"
        emptyRegistry={
          <>
            No skills yet. Add a folder with a SKILL.md to <code>~/.snaglet/skills</code>; see the{' '}
            <OpenSkillsViewLink>Skills view</OpenSkillsViewLink>.
          </>
        }
      />
      {error && <p className={styles.error}>Could not save: {error}</p>}
    </div>
  );
};
