import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Section, Segmented } from '@desktop/components';
import {
  skillsApi,
  type SkillDropReason,
  type SkillMode,
  type ThreadSkillState,
} from '@desktop/utils/api/skills';
import { SkillPicker } from './SkillPicker';
import { NEXT_RUN_HELP, useSkillList } from './AgentSkillsSection';
import styles from './skills.module.scss';

const MODE_HELP: Record<SkillMode, string> = {
  inherit: 'Uses the agent’s own skills.',
  add: 'The agent’s own skills plus the ones picked here.',
  override: 'Only the skills picked here; the agent’s own skills are ignored on this thread.',
};

const DROP_REASON: Record<SkillDropReason, string> = {
  invalid: 'invalid SKILL.md',
  unknown: 'no longer exists',
};

export interface ThreadSkillsSectionProps {
  threadId: string;
  agentId: string;
  agentName: string;
}

/**
 * Per-thread skills for one agent: Inherit / Add / Override,
 * the thread picks, and the effective list with where each skill comes from.
 * Shown whenever any skill exists (Add/Override can give skills to an agent
 * with none of its own); renders nothing while the user has no skills.
 * Built-in skills are never listed: every agent always has them.
 */
export const ThreadSkillsSection: FC<ThreadSkillsSectionProps> = ({
  threadId,
  agentId,
  agentName,
}) => {
  const { skills, error: listError } = useSkillList();
  const [state, setState] = useState<ThreadSkillState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    setState(null);
    skillsApi
      .threadSkills(threadId, agentId)
      .then((s) => alive && setState(s))
      .catch((e: unknown) => alive && setError(getErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, [threadId, agentId]);

  const save = useCallback(
    async (patch: { mode?: SkillMode; skillIds?: string[] }) => {
      if (!state) return;
      const previous = state;
      const mine = ++seq.current;
      setState({
        ...state,
        mode: patch.mode ?? state.mode,
        threadSkillIds: patch.skillIds ?? state.threadSkillIds,
      });
      setSaving(true);
      setError(null);
      try {
        const next = await skillsApi.setThreadSkills(threadId, agentId, patch);
        if (seq.current === mine) setState(next);
      } catch (e) {
        if (seq.current === mine) setState(previous);
        setError(getErrorMessage(e));
      } finally {
        if (seq.current === mine) setSaving(false);
      }
    },
    [state, threadId, agentId]
  );

  if (listError) {
    return (
      <Section label="Skills">
        <p className={styles.error}>Could not load skills: {listError}</p>
      </Section>
    );
  }
  if (skills && skills.length === 0) return null;
  if (!skills || !state) {
    return (
      <Section label="Skills">
        {error ? (
          <p className={styles.error}>{error}</p>
        ) : (
          <p className={styles.hint}>Loading skills…</p>
        )}
      </Section>
    );
  }

  const { effective, dropped } = state.resolved;

  return (
    <Section label="Skills" actions={<span className={styles.originTag}>{state.mode}</span>}>
      <div className={styles.stack}>
        <Segmented
          size="sm"
          fullWidth
          aria-label={`Skill mode for ${agentName}`}
          value={state.mode}
          onChange={(m) => void save({ mode: m as SkillMode })}
        >
          <Segmented.Option value="inherit">Inherit</Segmented.Option>
          <Segmented.Option value="add">Add</Segmented.Option>
          <Segmented.Option value="override">Override</Segmented.Option>
        </Segmented>
        <p className={styles.hint}>
          {MODE_HELP[state.mode]} {NEXT_RUN_HELP}
        </p>

        {state.mode !== 'inherit' && (
          <SkillPicker
            skills={skills}
            selected={state.threadSkillIds}
            onChange={(ids) => void save({ skillIds: ids })}
            disabled={saving}
            label={`Thread skills for ${agentName}`}
          />
        )}

        <p className={styles.subLabel}>Effective on this thread</p>
        {effective.length === 0 && dropped.length === 0 ? (
          <p className={styles.hint}>No skills.</p>
        ) : (
          <ul className={styles.effectiveList} aria-label="Effective skills">
            {effective.map(({ skill, origin }) => (
              <li key={skill.id} className={styles.effectiveItem}>
                <span className={styles.skillName}>{skill.slug}</span>
                <span className={styles.originTag}>
                  {origin === 'general' ? 'agent' : 'thread'}
                </span>
              </li>
            ))}
            {dropped.map((d) => {
              const known = skills.find((s) => s.id === d.skillId);
              return (
                <li key={`${d.origin}:${d.skillId}`} className={styles.droppedItem}>
                  <span className={styles.skillName}>{known?.slug ?? d.skillId}</span>
                  <span className={styles.originTag}>
                    {d.origin === 'general' ? 'agent' : 'thread'}
                  </span>
                  <span>— dropped: {DROP_REASON[d.reason]}</span>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className={styles.error}>Could not save: {error}</p>}
      </div>
    </Section>
  );
};
