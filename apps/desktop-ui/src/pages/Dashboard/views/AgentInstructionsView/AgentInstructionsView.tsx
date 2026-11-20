import { useCallback, useEffect, useState, type FC, type KeyboardEvent } from 'react';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Textarea } from '@desktop/components';
import { settingsApi } from '@desktop/utils/api';
import { shortcutHint } from '@desktop/utils/platform';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import styles from './AgentInstructionsView.module.scss';

/** The `agent.global_instructions` setting (apps/server settings registry). */
const CATEGORY = 'agent';
const KEY = 'global_instructions';

/** How long the "Saved" note stays after a save. */
const SAVED_NOTICE_MS = 2500;

/**
 * AgentInstructionsView — Settings → Agents (shown only while Home is off;
 * Home's Instructions card edits the same setting): one text the workspace owner
 * writes for every agent. The server adds it to every agent's system prompt
 * in every thread (workspaceInstructionsBlock).
 */
export const AgentInstructionsView: FC = () => {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    settingsApi
      .registry()
      .then((rows) => {
        if (canceled) return;
        const row = rows.find((r) => r.category === CATEGORY && r.key === KEY);
        const value = typeof row?.current === 'string' ? row.current : '';
        setSaved(value);
        setDraft(value);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load instructions'));
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const dirty = saved !== null && draft !== saved;

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    const value = draft;
    setSaving(true);
    setError(null);
    try {
      await settingsApi.put(CATEGORY, KEY, value);
      setSaved(value);
      setJustSaved(true);
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, saving]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 's' || event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  if (saved === null && !error) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading instructions…</StateHint>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.body}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <span className={styles.glyph} aria-hidden>
              ☺
            </span>
            <h1 className={styles.title}>Instructions for all agents</h1>
          </div>
          <p className={styles.subtitle}>Added to every agent’s instructions, in every thread.</p>
        </header>

        {saved !== null && (
          <Textarea
            id="agent-instructions-text"
            label="Instructions"
            fullWidth
            rows={14}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setJustSaved(false);
            }}
            onKeyDown={onKeyDown}
            maxLength={AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH}
            showCharCount
            placeholder="For example: Write in plain English. Ask before deleting anything."
          />
        )}

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {saved !== null && (
          <footer className={styles.actions}>
            <span className={styles.statusText} aria-live="polite">
              {dirty ? 'Unsaved changes' : justSaved ? 'Saved' : ''}
            </span>
            <Button
              variant="primary"
              size="md"
              onClick={() => void save()}
              disabled={!dirty}
              loading={saving}
              loadingText="Saving…"
              title={`Save (${shortcutHint('S')})`}
            >
              Save
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
};
