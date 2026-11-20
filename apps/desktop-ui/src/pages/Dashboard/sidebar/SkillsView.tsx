import { mountedDisclosure } from '@desktop/ws/sidebarMounted';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { skillsApi, type SkillFileEntry, type SkillInfo } from '@desktop/utils/api/skills';
import { Button } from '@desktop/components';
import { Tree, TreeRow } from '@desktop/components/SidebarTree';
import { DocIcon, FolderIcon, RefreshIcon } from '@desktop/components/Icons';
import { getErrorMessage } from '@snaglet/shared/utils';
import { SidebarView } from './SidebarView';
import styles from './SkillsView.module.scss';

/**
 * Live refresh cadence. The folder scanner updates `skill_registry` on its
 * own; this view re-reads the list while it is mounted and the window is
 * visible, so an edited/added/removed skill shows up without a reload.
 */
export const SKILLS_REFRESH_MS = 5_000;

interface SkillsViewProps {
  /** Open one file of a skill folder in the active pane (read-only viewer). */
  onFileOpen: (skill: { id: string; slug: string }, path: string) => void;
  /** Registry id of the skill whose file is open in the active pane. */
  activeSkillId: string | null;
}

type FilesState =
  | { status: 'loading' }
  | { status: 'loaded'; files: SkillFileEntry[]; truncated: boolean }
  | { status: 'error'; message: string };

/** Same list → same string, so a no-op refresh doesn't re-render rows. */
function listKey(skills: SkillInfo[]): string {
  return skills
    .map((s) => `${s.id}|${s.status}|${s.version ?? ''}|${s.error ?? ''}|${s.description}`)
    .join('\n');
}

/**
 * SkillsView — flat, read-only list of skills under `~/.snaglet/skills`.
 * Valid and invalid skills (⚠, error on hover) share one list sorted by slug;
 * a skill whose folder is removed simply disappears (its registry row is deleted).
 * Expanding a row lists its files; clicking a file opens SkillFileView.
 * There is no create/edit: skills are authored on disk.
 */
export const SkillsView: FC<SkillsViewProps> = ({ onFileOpen, activeSkillId }) => {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [files, setFiles] = useState<Record<string, FilesState>>({});
  const lastKey = useRef('');

  const loadFiles = useCallback((id: string) => {
    setFiles((prev) => ({ ...prev, [id]: prev[id] ?? { status: 'loading' } }));
    skillsApi
      .files(id)
      .then((r) =>
        setFiles((prev) => ({
          ...prev,
          [id]: { status: 'loaded', files: r.files, truncated: r.truncated },
        }))
      )
      .catch((err) =>
        setFiles((prev) => ({ ...prev, [id]: { status: 'error', message: getErrorMessage(err) } }))
      );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await skillsApi.list();
      setError(null);
      const key = listKey(next);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setSkills(next);
        // A changed skill may have gained/lost files: re-read open folders.
        setExpanded((open) => {
          for (const id of open) {
            if (next.some((s) => s.id === id)) loadFiles(id);
          }
          return open;
        });
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadFiles]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void refresh();
      }
    }, SKILLS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = (skill: SkillInfo) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(skill.id)) next.delete(skill.id);
      else {
        next.add(skill.id);
        loadFiles(skill.id);
      }
      return next;
    });
  };

  const reveal = (skill: SkillInfo) => {
    skillsApi.reveal(skill.id).catch((err) => setError(getErrorMessage(err)));
  };

  const renderFiles = (skill: SkillInfo) => {
    const state = files[skill.id];
    if (!state || state.status === 'loading') {
      return <div className={styles.note}>Loading files…</div>;
    }
    if (state.status === 'error') {
      return <div className={styles.error}>{state.message}</div>;
    }
    return (
      <>
        {state.files.map((f) => (
          <TreeRow
            key={f.path}
            data-inspect-name={f.path}
            depth={1}
            chevron="empty"
            icon={<DocIcon />}
            label={f.path}
            title={f.path}
            onClick={() => onFileOpen(skill, f.path)}
          />
        ))}
        {state.truncated && <div className={styles.note}>Folder truncated (too many files).</div>}
      </>
    );
  };

  const rowActions = (skill: SkillInfo) => (
    <span className={styles.actions}>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        className={styles.rowBtn}
        onClick={(event) => {
          event.stopPropagation();
          reveal(skill);
        }}
        title="Reveal in Finder"
        aria-label={`Reveal ${skill.slug} in Finder`}
      >
        <FolderIcon />
      </Button>
    </span>
  );

  return (
    <SidebarView
      title="Skills"
      actions={
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh skills"
        >
          <RefreshIcon />
        </Button>
      }
    >
      {error && <div className={styles.error}>Could not load skills: {error}</div>}
      {loading && skills.length === 0 && <div className={styles.note}>Loading…</div>}
      {!loading && skills.length === 0 && !error && (
        <div className={styles.note}>
          No skills yet. Add a folder with a SKILL.md under ~/.snaglet/skills.
        </div>
      )}
      <Tree
        data-sidebar-mounted={loading ? 'loading' : error ? 'error' : 'ready'}
        aria-label="Skills"
      >
        {skills.map((skill) => {
          const open = expanded.has(skill.id);
          const invalid = skill.status === 'invalid';
          return (
            <div
              key={skill.id}
              className={styles.group}
              data-sidebar-row-state={files[skill.id]?.status}
              data-sidebar-files-truncated={
                files[skill.id]?.status === 'loaded'
                  ? String((files[skill.id] as Extract<FilesState, { status: 'loaded' }>).truncated)
                  : undefined
              }
            >
              <TreeRow
                as="div"
                role="treeitem"
                tabIndex={0}
                data-sidebar-disclosure=""
                data-inspect-id={skill.id}
                ref={mountedDisclosure((value) => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (value) next.add(skill.id);
                    else next.delete(skill.id);
                    return next;
                  });
                  if (value && !files[skill.id]) loadFiles(skill.id);
                })}
                aria-expanded={open}
                chevron={{
                  open,
                  onToggle: (event) => {
                    event.stopPropagation();
                    toggle(skill);
                  },
                  'aria-label': open ? `Collapse ${skill.slug}` : `Expand ${skill.slug}`,
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle(skill);
                  }
                }}
                className={styles.row}
                active={activeSkillId === skill.id}
                label={
                  <span className={styles.slugLine}>
                    {invalid && (
                      <span
                        className={styles.warn}
                        role="img"
                        aria-label="Invalid skill"
                        title={skill.error ?? 'Invalid'}
                      >
                        ⚠
                      </span>
                    )}
                    <span className={styles.slug}>{skill.slug}</span>
                  </span>
                }
                description={
                  invalid ? (
                    <span className={styles.errorText}>{skill.error}</span>
                  ) : (
                    skill.description
                  )
                }
                title={invalid ? `${skill.slug}: ${skill.error ?? 'invalid'}` : skill.description}
                onClick={() => toggle(skill)}
                trailing={rowActions(skill)}
                data-inspect-name={skill.slug}
                data-inspect-selected={activeSkillId === skill.id}
                data-testid={`skill-row-${skill.slug}`}
              />
              {open && renderFiles(skill)}
            </div>
          );
        })}
      </Tree>
    </SidebarView>
  );
};
