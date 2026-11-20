import { useCallback, useEffect, useRef, useState } from 'react';
import type { FC, ReactNode } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { getErrorMessage, relativeFromNow } from '@snaglet/shared/utils';
import { DisclosureSection } from '@desktop/components';
import { useWs } from '@desktop/ws/useWs';
import { threadsApi, type ThreadContextUsage } from '@desktop/utils/api';
import styles from './ContextWindowPanel.module.scss';

interface ContextWindowPanelProps {
  threadId: string;
  agentId: string;
  /** Persisted effective model identity: thread override, otherwise agent default. */
  effectiveModel: { providerId: string; modelId: string } | null;
  /** Optional — surfaced in error messages for easier debugging */
  agentName?: string;
  /** Existing settings help affordance, kept next to the persistent action. */
  headerHint?: ReactNode;
}

/**
 * Self-contained panel that fetches and renders the current context-window
 * usage for a given (thread, agent) pair. Used inside the dashboard chat
 * settings' Agents tab and in AgentConfigCard's "Context Window" tab.
 *
 * Compact-state is server-driven: the button reflects
 * `socket:thread:compact:*` events scoped to this (thread, agent) plus a
 * /compact-status query on mount. That keeps the "Compacting…" label
 * correct after navigating away mid-run and coming back, and also picks
 * up compactions triggered from a peer client.
 */
export const ContextWindowPanel: FC<ContextWindowPanelProps> = ({
  threadId,
  agentId,
  effectiveModel,
  headerHint,
}) => {
  const { addMessageListener } = useWs();
  const [usage, setUsage] = useState<ThreadContextUsage | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorModelKey, setErrorModelKey] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const [compacting, setCompacting] = useState<boolean>(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [justCompactedAt, setJustCompactedAt] = useState<number | null>(null);
  // Tick once a minute so "Last compacted Xm ago" stays fresh without
  // hammering re-renders.
  const [, setNowTick] = useState(0);

  const effectiveProviderId = effectiveModel?.providerId ?? null;
  const effectiveModelId = effectiveModel?.modelId ?? null;
  const effectiveModelKey =
    effectiveProviderId && effectiveModelId
      ? JSON.stringify([effectiveProviderId, effectiveModelId])
      : null;
  const requestScopeKey = effectiveModelKey
    ? JSON.stringify([threadId, agentId, effectiveModelKey])
    : null;
  const activeRequestScopeRef = useRef(requestScopeKey);
  activeRequestScopeRef.current = requestScopeKey;

  const load = useCallback(
    async (opts?: { applySummary?: 'force' }) => {
      if (
        !effectiveProviderId ||
        !effectiveModelId ||
        effectiveModelKey === null ||
        requestScopeKey === null ||
        activeRequestScopeRef.current !== requestScopeKey
      ) {
        return;
      }
      const requestSequence = ++requestSequenceRef.current;
      setLoading(true);
      setError(null);
      setErrorModelKey(effectiveModelKey);
      try {
        const res = await threadsApi.getContextUsage(threadId, agentId, opts);
        if (
          requestSequence !== requestSequenceRef.current ||
          activeRequestScopeRef.current !== requestScopeKey
        ) {
          return;
        }
        if (res.provider !== effectiveProviderId || res.model !== effectiveModelId) {
          setUsage(null);
          setError(
            `Context usage is unavailable for ${effectiveProviderId} · ${effectiveModelId}. The server did not return matching model metadata.`
          );
          return;
        }
        setUsage(res);
      } catch (err) {
        if (
          requestSequence !== requestSequenceRef.current ||
          activeRequestScopeRef.current !== requestScopeKey
        ) {
          return;
        }
        const message = getErrorMessage(err, 'Failed to load context usage');
        setError(message);
      } finally {
        if (
          requestSequence === requestSequenceRef.current &&
          activeRequestScopeRef.current === requestScopeKey
        ) {
          setLoading(false);
        }
      }
    },
    [threadId, agentId, effectiveProviderId, effectiveModelId, effectiveModelKey, requestScopeKey]
  );

  const compact = useCallback(async () => {
    if (compacting) return;
    setCompactError(null);
    // Flip the button immediately for snappy UX. The socket event will keep
    // it true; the request resolving will reload usage and surface a brief
    // "just compacted" hint that times itself out.
    setCompacting(true);
    try {
      await threadsApi.compactAgent(threadId, agentId);
      // Server's :complete socket frame will clear `compacting`, but the
      // load happens here so the usage panel refreshes immediately on
      // this client even before the frame round-trips. Pass
      // `applySummary: 'force'` so the bar reflects post-compact size
      // even when the raw thread is still under the auto-compression
      // threshold — otherwise the estimator would early-return raw
      // tokens and the user would see no visible change.
      await load({ applySummary: 'force' });
      setJustCompactedAt(Date.now());
    } catch (err) {
      setCompacting(false);
      setCompactError(getErrorMessage(err, 'Compaction failed'));
    }
  }, [threadId, agentId, compacting, load]);

  // Cold load + check if a prior click is still running server-side.
  // Without this, navigating away during a 20s compaction and back shows a
  // clickable "Compact" even though one is in flight.
  useEffect(() => {
    let canceled = false;
    ++requestSequenceRef.current;
    setUsage(null);
    setLoading(false);
    setError(null);
    setErrorModelKey(effectiveModelKey);
    setCompacting(false);
    setCompactError(null);
    setJustCompactedAt(null);
    if (!effectiveProviderId || !effectiveModelId) {
      return () => {
        canceled = true;
        ++requestSequenceRef.current;
      };
    }
    void load();
    void threadsApi
      .getCompactStatus(threadId, agentId)
      .then((s) => {
        if (!canceled && s.compacting) setCompacting(true);
      })
      .catch((err: unknown) => {
        // Status is best-effort — failure here just means the button can
        // still be clicked, and the server will reject duplicate requests
        // with 409.
        console.error('ContextWindowPanel: failed to load compact status', err);
      });
    return () => {
      canceled = true;
      ++requestSequenceRef.current;
    };
  }, [threadId, agentId, effectiveProviderId, effectiveModelId, effectiveModelKey, load]);

  // Listen for compact events on the thread channel; flip our state when
  // they're scoped to our agent. The chat-view's useChatStream listens to
  // the same events for the AgentStatusBubbles pill — these two listeners
  // stay in sync because they read from the same socket frames.
  useEffect(() => {
    return addMessageListener((raw: WsMessage) => {
      if (raw.type === 'socket:thread:compact:started') {
        const p = raw.payload as { threadId: string; agentId?: string };
        if (p.threadId !== threadId) return;
        // Per-agent path emits agentId; only flip if it's ours. Thread-wide
        // compactions also flip every per-agent panel that happens to be
        // open on the thread (intentional — all participants are being
        // summarized in that case).
        if (p.agentId != null && p.agentId !== agentId) return;
        setCompacting(true);
        setCompactError(null);
      } else if (
        raw.type === 'socket:thread:compact:complete' ||
        raw.type === 'socket:thread:compact:error'
      ) {
        const p = raw.payload as { threadId: string; agentId?: string; message?: string };
        if (p.threadId !== threadId) return;
        if (p.agentId != null && p.agentId !== agentId) return;
        setCompacting(false);
        setJustCompactedAt(Date.now());
        if (raw.type === 'socket:thread:compact:error' && p.message) {
          setCompactError(p.message);
        }
        // Re-pull usage so the bar reflects the post-compact size.
        // Force the summary even if the raw thread is below the
        // auto-compression threshold — a peer compaction is still a
        // user-driven event and the bar should visibly drop here too.
        void load({ applySummary: 'force' });
      } else if (raw.type === 'socket:thread:summary') {
        // Auto-compaction: the run-end summarization pass persists a new
        // summary version and broadcasts only this frame, never compact:*
        // events. Reload so the version and "Last compacted … ago" follow the
        // summary that just landed instead of the previous one.
        const p = raw.payload as { threadId: string; agentId?: string };
        if (p.threadId !== threadId) return;
        if (p.agentId != null && p.agentId !== agentId) return;
        setJustCompactedAt(Date.now());
        void load({ applySummary: 'force' });
      }
    });
  }, [addMessageListener, threadId, agentId, load]);

  // Re-render the "Last compacted Xs/Xm ago" label on a cadence matched to
  // its resolution: every 10s while the label is still second-scale (<1m
  // old), then once a minute. A flat 60s interval let a fresh "12s ago" sit
  // frozen for a whole minute right when the user is watching it.
  useEffect(() => {
    const latest = usage?.latestSummary;
    if (!latest) return;
    const anchorMs = new Date(latest.createdAt ?? latest.updatedAt).getTime();
    let id: number;
    const schedule = () => {
      const secondScale = Number.isFinite(anchorMs) && Date.now() - anchorMs < 60_000;
      id = window.setTimeout(
        () => {
          setNowTick((t) => t + 1);
          schedule();
        },
        secondScale ? 10_000 : 60_000
      );
    };
    schedule();
    return () => window.clearTimeout(id);
  }, [usage?.latestSummary]);

  // The "just compacted" flash auto-clears after a few seconds so the panel
  // doesn't show a stale "just now" badge forever.
  useEffect(() => {
    if (justCompactedAt === null) return;
    const id = window.setTimeout(() => setJustCompactedAt(null), 6_000);
    return () => window.clearTimeout(id);
  }, [justCompactedAt]);

  const usageMatchesEffectiveModel =
    usage?.provider === effectiveProviderId && usage.model === effectiveModelId;
  const currentUsage = usageMatchesEffectiveModel ? usage : null;
  const currentError = errorModelKey === effectiveModelKey ? error : null;
  const summary = currentUsage
    ? `${currentUsage.tokens.estimated.toLocaleString()} / ${currentUsage.budget.contextWindowTokens.toLocaleString()} tokens · ${Math.round(currentUsage.percent * 10) / 10}%`
    : currentError
      ? 'Unavailable'
      : effectiveProviderId && effectiveModelId
        ? 'Estimating…'
        : 'Unavailable';

  return (
    <DisclosureSection
      label="Context window"
      summary={summary}
      className={styles.ctxCard}
      preview={currentUsage ? <ContextCompactionMeter usage={currentUsage} /> : null}
      previewClassName={styles.ctxCompactionPreview}
      bodyClassName={styles.ctxPanel}
      actions={
        <>
          {headerHint}
          <button
            type="button"
            className={styles.ctxCompactBtn}
            onClick={compact}
            disabled={compacting || loading || !effectiveProviderId || !effectiveModelId}
            title="Summarize this agent's older messages into a thread summary, shrinking the prompt next turn"
          >
            {compacting ? 'Compacting…' : 'Compact'}
          </button>
        </>
      }
    >
      {!effectiveProviderId || !effectiveModelId ? (
        <div className={styles.hint}>Context usage unavailable: no effective model configured.</div>
      ) : (loading || !currentUsage) && !currentError ? (
        <div className={styles.hint}>Estimating context…</div>
      ) : currentError && !currentUsage ? (
        <>
          <div className={styles.error}>{currentError}</div>
          <button type="button" className={styles.ctxRefresh} onClick={() => void load()}>
            Retry
          </button>
        </>
      ) : currentUsage ? (
        <>
          <ContextDiagnostics usage={currentUsage} loading={loading} onRefresh={load} />
          <div className={styles.ctxActions}>
            <CompactStatusLine
              latestSummary={currentUsage.latestSummary ?? null}
              compacting={compacting}
              justCompactedAt={justCompactedAt}
            />
            {compactError && <span className={styles.ctxCompactError}>{compactError}</span>}
          </div>
        </>
      ) : (
        <div className={styles.hint}>No data.</div>
      )}
    </DisclosureSection>
  );
};

interface ContextDiagnosticsProps {
  usage: ThreadContextUsage;
  loading: boolean;
  onRefresh: (opts?: { applySummary?: 'force' }) => Promise<void>;
}

const ContextCompactionMeter: FC<{ usage: ThreadContextUsage }> = ({ usage }) => {
  const { tokens, budget } = usage;
  const pctOfThreshold =
    budget.tokenThreshold > 0
      ? Math.min(100, (tokens.messageTokens / budget.tokenThreshold) * 100)
      : 0;
  const pctThresholdLabel = Math.round(pctOfThreshold * 10) / 10;
  const severity = pctOfThreshold >= 90 ? 'danger' : pctOfThreshold >= 75 ? 'warn' : 'ok';
  const severityClass = styles[`ctxBar_${severity}`] ?? '';

  return (
    <>
      <div className={styles.ctxSectionLabel}>Auto-compaction</div>
      <div
        className={`${styles.ctxBar} ${severityClass}`}
        role="progressbar"
        aria-label="Auto-compaction threshold usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctThresholdLabel}
      >
        <div className={styles.ctxBarFill} style={{ width: `${pctOfThreshold}%` }} />
      </div>
      <div className={styles.ctxBarLabel} data-tid="ctxCompactionHeadline">
        Messages {tokens.messageTokens.toLocaleString()} / {budget.tokenThreshold.toLocaleString()}{' '}
        tokens · {pctThresholdLabel}% of compaction threshold
      </div>
    </>
  );
};

const ContextDiagnostics: FC<ContextDiagnosticsProps> = ({ usage, loading, onRefresh }) => {
  const { tokens, budget, percent, percentOfUsable, provider, model } = usage;
  const pct = Math.round(percent * 10) / 10;
  const pctUsable = Math.round(percentOfUsable * 10) / 10;

  return (
    <>
      <div className={styles.ctxHeader}>
        <span className={styles.ctxModel}>
          {provider}
          {model ? ` · ${model}` : ''}
        </span>
        <button
          type="button"
          className={styles.ctxRefresh}
          onClick={() => void onRefresh()}
          disabled={loading}
          title="Recalculate"
          aria-label="Recalculate context usage"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className={styles.ctxSectionLabel}>Current context</div>
      <dl className={styles.ctxStats}>
        <div
          className={`${styles.ctxStatRow} ${styles.ctxStatRowPrimary}`}
          data-tid="ctxRequestTotal"
        >
          <dt>Total sent</dt>
          <dd>
            {tokens.estimated.toLocaleString()} / {budget.contextWindowTokens.toLocaleString()}{' '}
            tokens · {pct}%
          </dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Messages counted</dt>
          <dd>
            {tokens.messagesCounted}
            {tokens.compressed && tokens.keptMessages != null
              ? ` → ${tokens.keptMessages} after compression`
              : ''}
          </dd>
        </div>
        {tokens.compressed && tokens.raw != null ? (
          <div className={styles.ctxStatRow}>
            <dt>Raw (pre-compression)</dt>
            <dd>
              {tokens.raw.toLocaleString()} tokens · compressed to{' '}
              {tokens.estimated.toLocaleString()} tokens
              {tokens.threadSummaryUsed ? ' (summary used)' : ''}
            </dd>
          </div>
        ) : null}
        <div className={styles.ctxStatRow}>
          <dt>System prompt</dt>
          <dd>
            {tokens.systemPromptTokens.toLocaleString()} tokens (
            {tokens.systemPromptChars.toLocaleString()} chars)
          </dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Tool schemas</dt>
          <dd>
            {tokens.toolCatalogTokens.toLocaleString()} tokens · {tokens.toolCount} advertised
          </dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Messages</dt>
          <dd>{tokens.messageTokens.toLocaleString()} tokens</dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Usable message budget</dt>
          <dd>
            {budget.usableBudget.toLocaleString()} tokens · messages at {pctUsable}% of usable
          </dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Compression threshold</dt>
          <dd title="Auto-compaction summarizes older messages when message tokens exceed this">
            {budget.tokenThreshold.toLocaleString()} tokens
          </dd>
        </div>
        <div className={styles.ctxStatRow}>
          <dt>Output reserve</dt>
          <dd>{budget.maxOutputTokens.toLocaleString()} tokens</dd>
        </div>
      </dl>

      {budget.overheadFloored ? (
        <div className={styles.ctxFootnote}>
          System prompt + tool schemas exceed this model&apos;s window — the message budget was
          floored to keep the thread runnable.
        </div>
      ) : null}
    </>
  );
};

interface CompactStatusLineProps {
  latestSummary: ThreadContextUsage['latestSummary'] | null;
  compacting: boolean;
  justCompactedAt: number | null;
}

/**
 * Status text next to the Compact button.
 *
 *  - While compacting: nothing (the button label says it).
 *  - Right after a click resolves: "Just compacted to vN" — works even when
 *    the request was a no-op (version didn't bump) so the user gets visible
 *    confirmation that their click landed.
 *  - Otherwise: "Last compacted vN · Xm ago" when a summary exists, or
 *    "Never compacted" otherwise.
 */
const CompactStatusLine: FC<CompactStatusLineProps> = ({
  latestSummary,
  compacting,
  justCompactedAt,
}) => {
  if (compacting) return null;
  if (!latestSummary) {
    return <span className={styles.ctxCompactMeta}>Never compacted</span>;
  }
  const versionLabel = `v${latestSummary.version}`;
  if (justCompactedAt !== null) {
    return (
      <span className={`${styles.ctxCompactMeta} ${styles.ctxCompactMetaFresh}`}>
        Just compacted · {versionLabel}
      </span>
    );
  }
  // Anchor to the summary version's creation time, the actual compaction
  // moment. `updatedAt` is the node row's timestamp and drifts with unrelated
  // touches (embedding sync, repair passes); it is the fallback when
  // createdAt is absent.
  const compactedAtIso = latestSummary.createdAt ?? latestSummary.updatedAt;
  return (
    <span className={styles.ctxCompactMeta} title={new Date(compactedAtIso).toLocaleString()}>
      Last compacted {versionLabel} · {relativeFromNow(compactedAtIso)}
    </span>
  );
};
