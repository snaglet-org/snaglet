import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FC,
  type SyntheticEvent,
} from 'react';
import { setActiveDragChip, writeChipDragData } from '@desktop/utils/nodeChip/payload';
import { shortRunId } from '@desktop/utils/nodeChip/runChip';
import { canonicalToolName, readToolOp, resolveToolId } from '@snaglet/shared/utils';
import type { ActivityStep, RunActivity } from '../hooks/types';
import { activityStepsSignature } from '../hooks/chatStreamHelpers';
import styles from './MessageRow.module.scss';

const ACTIVITY_NEAR_BOTTOM_PX = 16;

interface ActivityDisclosureProps {
  activity: RunActivity;
  /** Display name for the run's agent; falls back to the agent id. */
  agentName?: string | null;
}

type ToolCallStep = Extract<ActivityStep, { kind: 'tool_call' }>;
type ActivityRenderItem =
  | { kind: 'step'; step: ActivityStep }
  | { kind: 'tool_bundle'; id: string; steps: ToolCallStep[] };

function groupActivitySteps(steps: ActivityStep[]): ActivityRenderItem[] {
  const items: ActivityRenderItem[] = [];
  let toolBundle: ToolCallStep[] = [];

  const flushToolBundle = () => {
    if (toolBundle.length === 1) {
      items.push({ kind: 'step', step: toolBundle[0] });
    } else if (toolBundle.length > 1) {
      items.push({
        kind: 'tool_bundle',
        id: `tool-bundle:${toolBundle[0].id}:${toolBundle[toolBundle.length - 1]?.id ?? toolBundle.length}`,
        steps: toolBundle,
      });
    }
    toolBundle = [];
  };

  for (const step of steps) {
    if (step.kind === 'tool_call') {
      toolBundle.push(step);
      continue;
    }
    flushToolBundle();
    items.push({ kind: 'step', step });
  }

  flushToolBundle();
  return items;
}

/**
 * Collapsible activity widget at the bottom of an agent bubble (a native
 * `<details>`). It mounts open while the run is live and collapses once when
 * the run completes; after that the user's toggle is left alone.
 */
export const ActivityDisclosure: FC<ActivityDisclosureProps> = ({ activity, agentName }) => {
  const isLive = activity.status === 'live';
  const [open, setOpen] = useState(isLive);
  // While the run is live, `now` ticks every second so the duration shows total
  // elapsed time; once it completes the duration is finishedAt - startedAt.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);
  const userToggledRef = useRef(false);
  const activityBodyRef = useRef<HTMLDivElement>(null);
  const activityAutoFollowRef = useRef(true);

  const isActivityNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= ACTIVITY_NEAR_BOTTOM_PX;
  }, []);

  // scrollTop our own pin last wrote. The scroll event a pin fires lands a frame
  // later, often after more output has grown the body: judged as "near bottom?"
  // then, it reads false and silently turns following off. Our own pin is not
  // the user scrolling away, so it is ignored.
  const pinnedTopRef = useRef<number | null>(null);
  const pinActivityToBottom = useCallback(() => {
    const el = activityBodyRef.current;
    if (!el || !activityAutoFollowRef.current) return;
    el.scrollTop = el.scrollHeight;
    pinnedTopRef.current = el.scrollTop;
  }, []);

  const handleActivityScroll = useCallback(() => {
    const el = activityBodyRef.current;
    if (!el) return;
    if (pinnedTopRef.current != null && Math.abs(el.scrollTop - pinnedTopRef.current) <= 1) return;
    pinnedTopRef.current = null;
    activityAutoFollowRef.current = isActivityNearBottom(el);
  }, [isActivityNearBottom]);

  // Auto-collapse exactly once when the run completes, unless the user
  // has already chosen an open/closed state for this run. Track previous
  // isLive in a ref so we only fire on the live->complete edge, not on
  // every render where isLive is false.
  const wasLiveRef = useRef(isLive);
  useEffect(() => {
    if (wasLiveRef.current && !isLive && !userToggledRef.current) {
      setOpen(false);
    }
    wasLiveRef.current = isLive;
  }, [isLive]);

  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    // Native `<details>` fires `toggle` whenever `open` changes, including on
    // mount and when the effect above drives it. Only a DOM value that
    // disagrees with React state is the user's; otherwise the mount toggle
    // would set `userToggledRef` and the auto-collapse would never fire.
    const next = e.currentTarget.open;
    if (next === open) return;
    userToggledRef.current = true;
    setOpen(next);
  };

  const activityScrollSignature = useMemo(
    () => activityStepsSignature(activity.steps),
    [activity.steps]
  );

  // Follow the tail: open (or reopen) at the newest step, not the first one.
  // Pinned before paint so a thread opened mid-run never flashes the top, then
  // again next frame for content that lays out late.
  useLayoutEffect(() => {
    if (!open) return;
    pinActivityToBottom();
    const frame = requestAnimationFrame(pinActivityToBottom);
    return () => cancelAnimationFrame(frame);
  }, [activityScrollSignature, open, pinActivityToBottom]);

  // A step's output, a code block or a whole tool bundle keeps growing without
  // a new step (so without a signature change): keep the tail in view while the
  // user follows. Same idea as the message list's row observer.
  useEffect(() => {
    const el = activityBodyRef.current;
    if (!open || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => pinActivityToBottom());
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [activityScrollSignature, open, pinActivityToBottom]);

  const thinkingCount = activity.steps.filter((s) => s.kind === 'thinking').length;
  const toolCount = activity.steps.filter((s) => s.kind === 'tool_call').length;
  // Wall-clock run duration from the run's timestamps, not the sum of tool-call
  // durations. Without startedAt it is 0, so no duration renders (never NaN).
  const startedMs = activity.startedAt ? new Date(activity.startedAt).getTime() : 0;
  const endMs = isLive ? now : activity.finishedAt ? new Date(activity.finishedAt).getTime() : now;
  const runMs = startedMs ? Math.max(0, endMs - startedMs) : 0;
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
  if (runMs > 0) parts.push(`${(runMs / 1000).toFixed(1)}s`);
  const summary = parts.length > 0 ? parts.join(' · ') : isLive ? 'starting…' : 'no steps';
  const renderItems = useMemo(() => groupActivitySteps(activity.steps), [activity.steps]);

  return (
    <details className={styles.activity} open={open} onToggle={onToggle}>
      <summary className={styles.activitySummary}>
        {isLive && <span className={styles.activityLivePulse}>live</span>}
        {summary}
        <RunChip runId={activity.runId} agentName={agentName ?? activity.agentId} />
      </summary>
      <div ref={activityBodyRef} className={styles.activityBody} onScroll={handleActivityScroll}>
        {renderItems.map((item) =>
          item.kind === 'tool_bundle' ? (
            <ToolBundleView key={item.id} steps={item.steps} />
          ) : (
            <ActivityStepView key={item.step.id} step={item.step} transient={isLive} />
          )
        )}
        {activity.steps.length === 0 && (
          <div className={styles.activityLine}>
            <span className={styles.activityLabel}>waiting…</span>
          </div>
        )}
      </div>
    </details>
  );
};

/**
 * Compact run chip in the disclosure header: click copies the run id, and the
 * chip is draggable as a `run` chip (same payload as the sidebar rows), so the
 * id can be grabbed mid-run and dropped into a chip input, the hook tester or
 * a code editor.
 *
 * Lives inside `<summary>`, which is a native toggle — every handler here
 * stops propagation and suppresses the default so interacting with the chip
 * never opens/closes the disclosure.
 */
const RunChip: FC<{ runId: string; agentName: string | null }> = ({ runId, agentName }) => {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  // Clear any pending "copied" reset if the chip unmounts first (the run
  // bubble can disappear on thread switch), so the timer can't fire into an
  // unmounted component.
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    []
  );

  const label = shortRunId(runId);
  const title = agentName ? `${agentName} · ${runId}` : runId;

  // Clipboard API is async and can reject (permissions, insecure origin);
  // failing silently is fine here — the id is still visible in the title.
  const copyRunId = useCallback(() => {
    void navigator.clipboard?.writeText(runId).then(
      () => {
        setCopied(true);
        if (resetRef.current !== null) window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined
    );
  }, [runId]);

  // `<summary>` would otherwise toggle the disclosure on this click or key.
  const handleCopy = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
      copyRunId();
    },
    [copyRunId]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLSpanElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      copyRunId();
    },
    [copyRunId]
  );

  const handleDragStart = useCallback(
    (e: ReactDragEvent<HTMLSpanElement>) => {
      e.stopPropagation();
      writeChipDragData(e.dataTransfer, {
        id: runId,
        kind: 'run',
        title: agentName ? `${agentName} · ${label}` : label,
      });
      // 'all' so each receiver picks its own dropEffect (editors use 'copy',
      // the composer uses 'link') — a narrower value silently blocks drops.
      e.dataTransfer.effectAllowed = 'all';
    },
    [runId, agentName, label]
  );

  return (
    <span
      className={styles.activityRunChip}
      role="button"
      tabIndex={0}
      draggable
      data-run-id={runId}
      // Distinct from the sidebar rows' `data-run-id`: both surfaces render
      // the same run, so tests need to address this one unambiguously.
      data-run-chip={runId}
      title={copied ? 'Copied run id' : `Copy run id — ${title}`}
      aria-label={`Run ${runId}${agentName ? ` by ${agentName}` : ''} — click to copy`}
      onClick={handleCopy}
      onKeyDown={handleKeyDown}
      onDragStart={handleDragStart}
      onDragEnd={() => setActiveDragChip(null)}
    >
      {copied ? 'copied' : label}
    </span>
  );
};

const ToolBundleView: FC<{ steps: ToolCallStep[] }> = ({ steps }) => {
  const completed = steps.filter((step) => step.status === 'done').length;
  const failures = steps.filter((step) => step.status === 'done' && step.success === false).length;
  const running = completed < steps.length;
  const totalDuration = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const label = running
    ? `tools… ${completed}/${steps.length}`
    : failures > 0
      ? `tools ✗ ${failures}/${steps.length}`
      : `tools ✓ ${steps.length}`;

  return (
    <div className={styles.toolBundle}>
      <div className={`${styles.activityLine} ${failures > 0 ? styles.activityErrored : ''}`}>
        <span className={styles.activityLabel}>[{label}]</span>
        <span className={styles.toolName}>tool bundle</span>
        {totalDuration > 0 && <span className={styles.activityDuration}>{totalDuration}ms</span>}
      </div>
      <div className={styles.toolBundleItems}>
        {steps.map((step) => (
          <ToolBundleItem key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
};

/** Prefix the chat log puts on calls routed through the `action` gateway. */
const ACTION_PREFIX = 'action__';

/**
 * A logged tool call as people read it: the canonical id, the op a merged tool
 * ran (`shell(op:run)`), plus the alias id when the call was logged under one
 * (`exec_command` reads as `shell`). An alias id pins its op, so a call logged
 * under one shows that op even though its input carries none.
 */
function displayToolName(
  name: string,
  input: Record<string, unknown>
): { id: string; op: string | null; aliasedFrom: string | null } {
  const prefix = name.startsWith(ACTION_PREFIX) ? ACTION_PREFIX : '';
  const bare = name.slice(prefix.length);
  const shown = canonicalToolName(bare);
  const op = resolveToolId(bare).op ?? readToolOp(input);
  return { id: `${prefix}${shown.id}`, op, aliasedFrom: shown.aliasedFrom };
}

const ToolNameLabel: FC<{ step: ToolCallStep }> = ({ step }) => {
  const { id, op, aliasedFrom } = displayToolName(step.toolName, step.input);
  const opLabel = op ? `(op:${op})` : '';
  return (
    <span
      className={styles.toolName}
      title={`${id}${opLabel}${aliasedFrom ? ` (was ${aliasedFrom})` : ''}`}
    >
      {id}
      {opLabel && <span className={styles.toolOp}>{opLabel}</span>}
      {aliasedFrom && <span className={styles.toolNameWas}>was {aliasedFrom}</span>}
    </span>
  );
};

/** Tool-call label + errored flag, shared by the bundled and standalone views. */
function toolCallChrome(step: ToolCallStep): { label: string; errored: boolean } {
  const errored = step.status === 'done' && step.success === false;
  const label = step.status === 'running' ? 'tool…' : errored ? 'tool ✗' : 'tool ✓';
  return { label, errored };
}

/** Input / output / error `<pre>` blocks for one tool call. Position-stable
 *  so it renders identically inside a bundle item and a standalone step. */
const ToolCallPayloads: FC<{ step: ToolCallStep }> = ({ step }) => {
  const hasInput = step.input != null && Object.keys(step.input).length > 0;
  return (
    <>
      {hasInput && (
        <pre className={styles.toolPayload} title="tool input">
          {formatJson(step.input)}
        </pre>
      )}
      {step.output && (
        <pre className={styles.toolPayload} title="tool output">
          {truncatePayload(step.output)}
        </pre>
      )}
      {step.status === 'done' && step.success === false && step.error && (
        <pre className={`${styles.toolPayload} ${styles.toolPayloadError}`} title="tool error">
          {step.error}
        </pre>
      )}
    </>
  );
};

const ToolBundleItem: FC<{ step: ToolCallStep }> = ({ step }) => {
  const { label, errored } = toolCallChrome(step);
  return (
    <div className={styles.toolBundleItem}>
      <div className={`${styles.activityLine} ${errored ? styles.activityErrored : ''}`}>
        <span className={styles.activityLabel}>[{label}]</span>
        <ToolNameLabel step={step} />
        {step.durationMs != null && (
          <span className={styles.activityDuration}>{step.durationMs}ms</span>
        )}
      </div>
      <ToolCallPayloads step={step} />
    </div>
  );
};

const ActivityStepView: FC<{ step: ActivityStep; transient: boolean }> = ({ step, transient }) => {
  if (step.kind === 'thinking') {
    return (
      <>
        <div className={styles.activityLine}>
          <span className={styles.activityLabel}>thinking</span>
        </div>
        <div className={styles.thinkingBlock}>{step.text || '…'}</div>
      </>
    );
  }
  if (step.kind === 'note') {
    // Inline system notice — model fallback / cache reset.
    return (
      <div className={`${styles.activityLine} ${styles.activityNote}`}>
        <span className={styles.activityLabel}>[note]</span>
        <span>{step.text}</span>
      </div>
    );
  }
  if (
    transient &&
    step.kind === 'tool_call' &&
    (step.toolName === 'capture_user_screen' || step.toolName === 'capture_user_camera')
  ) {
    const failed = step.status === 'done' && step.success === false;
    return (
      <div
        className={`${styles.visionCaptureCard} ${failed ? styles.activityErrored : ''}`}
        role="status"
      >
        <span className={styles.visionCapturePulse} aria-hidden />
        <strong>
          {failed
            ? 'Vision capture failed'
            : step.status === 'done'
              ? 'Capture prepared for current turn'
              : 'Capturing vision'}
        </strong>
        {failed && step.error && <span>{step.error}</span>}
      </div>
    );
  }
  const { label, errored } = toolCallChrome(step);
  return (
    <>
      <div className={`${styles.activityLine} ${errored ? styles.activityErrored : ''}`}>
        <span className={styles.activityLabel}>[{label}]</span>
        <ToolNameLabel step={step} />
        {step.durationMs != null && (
          <span className={styles.activityDuration}>{step.durationMs}ms</span>
        )}
      </div>
      <ToolCallPayloads step={step} />
    </>
  );
};

/**
 * Pretty-printed JSON for tool input. Falls back to String() on a circular
 * reference, so a malformed payload can't break the chat.
 */
function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Tool output can be arbitrarily large (whole file contents, search
 *  result lists). Hard-cap at 1200 chars in the inline preview; the
 *  full result is still in the activity log if anyone needs it. */
const TOOL_OUTPUT_MAX = 1200;
function truncatePayload(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  const trimmed = text.slice(0, TOOL_OUTPUT_MAX);
  return `${trimmed}\n… (${text.length - TOOL_OUTPUT_MAX} more chars)`;
}
