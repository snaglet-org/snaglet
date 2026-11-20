import { useCallback, useEffect, useState, type FC } from 'react';
import { threadsApi, settingsApi } from '@desktop/utils/api';
import { Checkbox, Cluster, Section, Stack, TextInput } from '@desktop/components';
import styles from './ChatSettings.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { DEFAULT_CONVERSATION_OUTPUT_TOKENS } from '@snaglet/shared/constants';
import { InfoHint } from './InfoHint';

// Finite draft suggestion only; the default is No limit.
const SUGGESTED_MAX_WAVES = 24;

interface ConversationLimitsProps {
  threadId: string;
}

/**
 * How far one message may run in this thread: the max dispatch waves and the
 * conversation output-token budget. Shown in the Context tab of every
 * thread's settings, a subagent's thread included (it has no Routing tab).
 */
export const ConversationLimits: FC<ConversationLimitsProps> = ({ threadId }) => {
  const [loading, setLoading] = useState(true);
  // Until the thread has loaded, the fields hold placeholders rather than the
  // thread's limits, so a failed load keeps them locked: saving from there
  // would overwrite limits the user never saw.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Max dispatch waves — thread-level cap on how many dispatch waves a single
  // user message can trigger. Persisted in threads.max_waves. Three states:
  //   undefined → editing a finite cap locally (box unchecked)
  //   number    → cap, honored exactly, no server clamp (box unchecked)
  //   null      → unbounded (box checked). Waves alone can't end the
  //               conversation; total output tokens (ceiling 192k) still do.
  const [persistedWaves, setPersistedWaves] = useState<number | null | undefined>(undefined);
  const [wavesDraft, setWavesDraft] = useState(String(SUGGESTED_MAX_WAVES));
  const wavesNoLimit = persistedWaves === null && !loading;

  // Conversation output-token cap (config_json.budget.maxTotalOutputTokens):
  // total output across every agent answering one message, a runaway guard
  // that stops further dispatch. It never shortens a single reply — each
  // reply may use the model's full output length. Blank means the settings
  // default (the 192k server ceiling); larger values are clamped to that
  // ceiling with a logged clamp.
  const [tokensDraft, setTokensDraft] = useState('');
  const [persistedTokens, setPersistedTokens] = useState<number | null>(null);
  const locked = loading || saving || loadFailed;

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    setSavedAt(null);
    setPersistedWaves(undefined);
    Promise.all([
      threadsApi.get(threadId),
      threadsApi.listParticipants(threadId),
      settingsApi.registry(),
    ])
      .then(([thread, participants, registry]) => {
        if (canceled) return;
        // Hydrate maxWaves from its column. The wire uses -1 for "genuinely
        // unbounded" so it stays distinguishable from null = absent override
        // (default No limit); the UI keeps representing unbounded as null.
        const profile = registry.find(
          (row) =>
            row.category === 'budget' && row.key === (participants.length > 1 ? 'group' : 'solo')
        );
        const inherited = (profile?.current as { maxWaves?: number | null } | undefined)?.maxWaves;
        const w = thread.maxWaves ?? inherited;
        if (w === -1) {
          setPersistedWaves(null);
        } else if (typeof w === 'number') {
          setPersistedWaves(w);
          setWavesDraft(String(w));
        } else {
          setPersistedWaves(null);
        }
        const tokens =
          typeof thread.maxTotalOutputTokens === 'number' ? thread.maxTotalOutputTokens : null;
        setPersistedTokens(tokens);
        setTokensDraft(tokens === null ? '' : String(tokens));
      })
      .catch((err) => {
        if (canceled) return;
        setLoadFailed(true);
        setError(getErrorMessage(err, 'Failed to load thread'));
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

  // Max dispatch waves
  const commitWaves = useCallback(
    async (value: number | null) => {
      if (locked) return;
      setSaving(true);
      setError(null);
      try {
        const updated = await threadsApi.updateMaxWaves(threadId, value);
        const w = updated.maxWaves;
        setPersistedWaves(w === -1 ? null : typeof w === 'number' ? w : null);
        if (typeof w === 'number' && w !== -1) setWavesDraft(String(w));
        setSavedAt(Date.now());
      } catch (err) {
        setError(getErrorMessage(err, 'Save failed'));
      } finally {
        setSaving(false);
      }
    },
    [locked, threadId]
  );

  const handleWavesNoLimitToggle = (nextChecked: boolean) => {
    if (nextChecked) {
      // null = genuinely unbounded waves. The conversation still stops on the
      // token budget — there is no clamp here to silently cap it.
      void commitWaves(null);
    } else {
      // Leave no-limit mode locally so the numeric field becomes editable, but
      // do not persist a guessed cap: the existing blur/Enter path commits only
      // after the user chooses a value. Seed the draft with a finite suggestion.
      setPersistedWaves(undefined);
      setWavesDraft(String(SUGGESTED_MAX_WAVES));
    }
  };

  const commitWavesDraft = useCallback(() => {
    if (wavesNoLimit || locked) return;
    const n = Number(wavesDraft.trim());
    if (!Number.isInteger(n) || n < 1) {
      setError('Must be a positive whole number.');
      return;
    }
    if (n === persistedWaves) return;
    void commitWaves(n);
  }, [wavesDraft, persistedWaves, locked, wavesNoLimit, commitWaves]);

  const onWavesKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitWavesDraft();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setWavesDraft(
        typeof persistedWaves === 'number' ? String(persistedWaves) : String(SUGGESTED_MAX_WAVES)
      );
      setError(null);
      e.currentTarget.blur();
    }
  };

  // Conversation budget overrides
  const commitBudgetField = useCallback(
    async (raw: string) => {
      if (locked) return;
      const trimmed = raw.trim();
      let nextValue: number | undefined;
      if (trimmed === '') {
        nextValue = undefined; // back to the settings default
      } else {
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n < 1) {
          setError('Must be a positive whole number (or blank for the default).');
          return;
        }
        nextValue = n;
      }
      // Leaving the field without a change is not a save.
      if ((nextValue ?? null) === persistedTokens) {
        setError(null);
        setTokensDraft(persistedTokens === null ? '' : String(persistedTokens));
        return;
      }
      setSaving(true);
      setError(null);
      try {
        // Its own column, so clearing is an explicit null.
        const updated = await threadsApi.updateMaxTotalOutputTokens(threadId, nextValue ?? null);
        const tokens =
          typeof updated.maxTotalOutputTokens === 'number' ? updated.maxTotalOutputTokens : null;
        setPersistedTokens(tokens);
        setTokensDraft(tokens === null ? '' : String(tokens));
        setSavedAt(Date.now());
      } catch (err) {
        setError(getErrorMessage(err, 'Save failed'));
      } finally {
        setSaving(false);
      }
    },
    [locked, persistedTokens, threadId]
  );

  return (
    <Stack gap={4}>
      <Section
        label={
          <span className={styles.labelWithHint}>
            <label htmlFor="max-waves-input">Max dispatch waves</label>
            <InfoHint
              topic="max dispatch waves"
              text={`Limits how many dispatch waves one message can trigger. Default No limit; explicit values are honored exactly. In all or @mention mode, every eligible agent runs per wave. No limit removes only this brake—the conversation still stops at the configured output-token budget or another stopping condition.`}
            />
          </span>
        }
      >
        <Cluster gap={2}>
          <TextInput
            id="max-waves-input"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            size="sm"
            value={wavesDraft}
            onChange={(e) => setWavesDraft(e.target.value)}
            onBlur={commitWavesDraft}
            onKeyDown={onWavesKey}
            disabled={wavesNoLimit || locked}
            containerClassName={styles.dispatchesInput}
            aria-disabled={wavesNoLimit}
          />
          <Checkbox
            checked={wavesNoLimit}
            onChange={handleWavesNoLimitToggle}
            disabled={locked}
            className={styles.dispatchesInfiniteLabel}
          >
            No limit
          </Checkbox>
        </Cluster>
      </Section>

      <Section
        label={
          <span className={styles.labelWithHint}>
            Conversation budget
            <InfoHint
              topic="conversation budget"
              text="Caps total output tokens across all agents for one message. A runaway guard: once reached, no further agents or waves run. It never shortens a single reply. Leave blank to use the default; values above the server ceiling are capped and logged."
            />
          </span>
        }
      >
        <Cluster gap={2}>
          <label htmlFor="budget-tokens-input" className={styles.dispatchesInfiniteLabel}>
            Output tokens
          </label>
          <TextInput
            id="budget-tokens-input"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            size="sm"
            placeholder={String(DEFAULT_CONVERSATION_OUTPUT_TOKENS)}
            value={tokensDraft}
            onChange={(e) => setTokensDraft(e.target.value)}
            onBlur={() => void commitBudgetField(tokensDraft)}
            disabled={locked}
            containerClassName={styles.dispatchesInput}
          />
        </Cluster>
      </Section>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <span className={styles.statusText} aria-live="polite">
        {saving ? 'Saving…' : savedAt ? 'Saved' : loading || loadFailed ? '' : 'Up to date'}
      </span>
    </Stack>
  );
};
