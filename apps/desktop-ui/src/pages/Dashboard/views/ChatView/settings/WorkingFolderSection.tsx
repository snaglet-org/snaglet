/**
 * Thread settings → Folder: where this thread's agents start when they wake
 * (the working directory of their shell and file tools). The default is the
 * project's linked folder, or Snaglet home when the thread isn't in a project with
 * a folder; a person can instead point the thread at one folder inside the
 * project, such as a worktree. The server decides what is allowed and what is
 * actually used, so this shows its answer rather than guessing.
 */
import { useCallback, useEffect, useState, type FC } from 'react';
import { Button, Section, Stack, TextInput } from '@desktop/components';
import { threadsApi, type ThreadWorkingDirectory } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './ChatSettings.module.scss';
import folderStyles from './WorkingFolderSection.module.scss';

const SOURCE_LABEL: Record<ThreadWorkingDirectory['source'], string> = {
  thread: 'Set on this thread',
  project: 'The project folder (default)',
  home: 'Snaglet home (default)',
};

interface WorkingFolderSectionProps {
  threadId: string;
}

export const WorkingFolderSection: FC<WorkingFolderSectionProps> = ({ threadId }) => {
  const [info, setInfo] = useState<ThreadWorkingDirectory | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const next = await threadsApi.getWorkingDirectory(threadId);
    setInfo(next);
    setDraft(next.workingDirectory ?? '');
  }, [threadId]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    setInfo(null);
    threadsApi
      .getWorkingDirectory(threadId)
      .then((next) => {
        if (canceled) return;
        setInfo(next);
        setDraft(next.workingDirectory ?? '');
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load the folder'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 1800);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const save = async (value: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await threadsApi.setWorkingDirectory(threadId, value);
      await load();
      setSavedAt(Date.now());
    } catch (err) {
      // The server's reason ("must be inside the project folder", "does not exist").
      setError(getErrorMessage(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const saved = info?.workingDirectory ?? '';
  const trimmed = draft.trim();
  const dirty = trimmed !== saved;
  const canSet = info?.projectFolder != null;

  return (
    <Stack gap={4} className={styles.pane}>
      <p className={styles.sectionDescription}>
        Where agents in this thread start when they wake, for running commands and reading files. By
        default that is the project&rsquo;s folder, or Snaglet home when the thread isn&rsquo;t in a
        project with a folder.
      </p>

      <Section label="Starts in">
        {loading ? (
          <div className={styles.routingPlaceholder}>Loading…</div>
        ) : info ? (
          <div className={folderStyles.current}>
            <code className={folderStyles.path} data-testid="effective-folder">
              {info.effective}
            </code>
            <span className={folderStyles.source}>
              {SOURCE_LABEL[info.source]}
              {info.source === 'thread' && info.workingDirectory == null
                ? ', inherited from the parent thread'
                : ''}
            </span>
          </div>
        ) : null}
        {info?.overrideProblem && (
          <p className={folderStyles.warning} role="status">
            The saved folder can&rsquo;t be used: {info.overrideProblem} Agents start in the default
            above until it&rsquo;s fixed or cleared.
          </p>
        )}
      </Section>

      {info && (
        <Section label="This thread's folder">
          <TextInput
            size="sm"
            aria-label="Thread working folder"
            placeholder={
              canSet
                ? `${info.projectFolder}/.snaglet/worktrees/…`
                : 'Needs a project with a folder'
            }
            value={draft}
            disabled={!canSet || saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dirty && trimmed) {
                event.preventDefault();
                void save(trimmed);
              }
            }}
          />
          <p className={folderStyles.hint}>
            {canSet
              ? 'An existing folder inside the project’s folder, such as a worktree under .snaglet/worktrees. Leave it empty to use the default.'
              : 'This thread isn’t in a project with a linked folder, so agents start in Snaglet home. Move it into a project with a folder to choose one.'}
          </p>
          <div className={folderStyles.actions}>
            <Button
              size="sm"
              variant="primary"
              disabled={!canSet || saving || !dirty || !trimmed}
              onClick={() => void save(trimmed)}
            >
              Save folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving || (!info.workingDirectory && !draft)}
              onClick={() => {
                if (info.workingDirectory) void save(null);
                else setDraft('');
              }}
            >
              Use the default
            </Button>
          </div>
        </Section>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <span className={styles.statusText} aria-live="polite">
        {saving ? 'Saving…' : savedAt ? 'Saved' : ''}
      </span>
    </Stack>
  );
};
