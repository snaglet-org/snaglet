import { useCallback, useEffect, useState, type FC } from 'react';
import { threadsApi } from '@desktop/utils/api';
import { Radio, RadioGroup, Section, Stack } from '@desktop/components';
import styles from './ChatSettings.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { InfoHint } from './InfoHint';

type DispatchMode = 'all' | 'mentioned';

const ROUTING_OPTIONS: Array<{
  value: DispatchMode;
  label: string;
  description: string;
}> = [
  {
    value: 'all',
    label: 'All (broadcast)',
    description: 'Every agent replies in parallel every turn — fastest but noisiest.',
  },
  {
    value: 'mentioned',
    label: '@mention only',
    description:
      'Only agents that you or another agent @mentions reply. With one agent in the thread, it replies to every message.',
  },
];

interface RoutingSectionProps {
  threadId: string;
}

export const RoutingSection: FC<RoutingSectionProps> = ({ threadId }) => {
  const [mode, setMode] = useState<DispatchMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    setMode(null);
    threadsApi
      .get(threadId)
      .then((thread) => {
        if (canceled) return;
        setMode(thread.dispatchMode ?? 'all');
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Failed to load thread'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);

  // Auto-dismiss the "Saved" indicator so it doesn't linger.
  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 1800);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const handleModeSelect = useCallback(
    async (next: DispatchMode) => {
      if (next === mode || saving) return;
      const previous = mode;
      setMode(next); // optimistic
      setSaving(true);
      setError(null);
      try {
        const updated = await threadsApi.updateDispatchMode(threadId, next);
        setMode(updated.dispatchMode ?? next);
        setSavedAt(Date.now());
      } catch (err) {
        setMode(previous);
        setError(getErrorMessage(err, 'Save failed'));
      } finally {
        setSaving(false);
      }
    },
    [mode, saving, threadId]
  );

  return (
    <Stack gap={4} className={styles.pane}>
      <p className={styles.sectionDescription}>
        Controls who replies each turn and how often. Limits on how far one message runs are in the
        General tab.
        <InfoHint
          topic="routing modes"
          text="Cadence (parallel vs taking turns) is built into the mode you pick — there's no separate toggle."
        />
      </p>

      <Section label="Mode">
        {/* After a failed load there is no mode to show; the error below
            explains it rather than a "Loading…" that never ends. */}
        {loading ? (
          <div className={styles.routingPlaceholder}>Loading…</div>
        ) : mode === null ? null : (
          <RadioGroup
            className={styles.routingOptions}
            name="dispatch-mode"
            value={mode}
            onChange={(next) => void handleModeSelect(next as DispatchMode)}
            disabled={saving}
            aria-label="Dispatch mode"
          >
            {ROUTING_OPTIONS.map((opt) => (
              <Radio key={opt.value} value={opt.value} description={opt.description}>
                {opt.label}
              </Radio>
            ))}
          </RadioGroup>
        )}
      </Section>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <span className={styles.statusText} aria-live="polite">
        {saving ? 'Saving…' : savedAt ? 'Saved' : loading || mode === null ? '' : 'Up to date'}
      </span>
    </Stack>
  );
};
