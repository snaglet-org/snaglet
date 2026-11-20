import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FC,
} from 'react';
import { Button, Select, Textarea, TextInput } from '@desktop/components';
import { BuilderTestConsole, useTestConsoleEntries } from '@desktop/components/BuilderTestConsole';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import {
  hooksWorkspacesApi,
  schedulesApi,
  type HookCheckResult,
  type HookDeclaredMeta,
  type HookRunInput,
} from '@desktop/utils/api';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { hasChipDragData, readChipDragData } from '@desktop/utils/nodeChip/payload';
import { isHookSchedule } from './HookSchedulesPanel';
import { HOOK_EVENT_NAMES, HOOK_TRIGGER_LABELS, type HookEventName } from './scaffold';
import {
  buildScheduleFireEvent,
  extractNodeRefs,
  parseTriggersFromCode,
  TRIGGER_PARAM_SPECS,
} from './hookTestConsoleSupport';
import consoleStyles from '@desktop/components/BuilderTestConsole/BuilderTestConsole.module.scss';

export interface HookTestConsoleProps {
  hookName: string;
  /** Live editor content — triggers are parsed straight from it so the
   *  console's inputs track unsaved edits, not just the saved file. */
  code: string;
  /** Persist any unsaved editor changes through the panel's normal save path
   *  before a run — the run endpoint executes saved code only. */
  ensureSaved: () => Promise<void>;
  disabled?: boolean;
}

/**
 * The hook builder's collapsible test surface (shell: BuilderTestConsole).
 * The event picker offers the triggers parsed from the editor's code, and
 * each event renders the input it needs (TRIGGER_PARAM_SPECS): an entity chip
 * or pasted id, a run id, table and entry ids, or nothing for schedule:fire.
 *
 * Raw JSON is the advanced fallback (an entity input wins when both are set),
 * and after an entity run it shows the resolved payload. Each run saves the
 * editor, then calls `POST check` (build errors land here), then `POST run`.
 */
export const HookTestConsole: FC<HookTestConsoleProps> = ({
  hookName,
  code,
  ensureSaved,
  disabled = false,
}) => {
  const { entries, append, clear } = useTestConsoleEntries(`hook:${hookName}`);
  const [expanded, setExpanded] = useState(false);
  const [declared, setDeclared] = useState<HookDeclaredMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [eventName, setEventName] = useState<HookEventName>('message:create');
  const eventTouchedRef = useRef(false);
  // Per-event values so switching triggers doesn't clobber a half-built input.
  const [paramsByEvent, setParamsByEvent] = useState<Record<string, string>>({});
  // table_entry:* events take a second id (the entry); the table id lives in
  // paramsByEvent like every other single-value input.
  const [entryIdsByEvent, setEntryIdsByEvent] = useState<Record<string, string>>({});
  const [rawJson, setRawJson] = useState('');
  const [running, setRunning] = useState(false);
  const metaLoadedRef = useRef(false);

  const parsed = useMemo(() => parseTriggersFromCode(code), [code]);
  // schedule: alone (no on:) still makes schedule:fire testable.
  const detectedEvents = useMemo<HookEventName[]>(() => {
    const events = [...parsed.events];
    if (parsed.hasSchedule && !events.includes('schedule:fire')) events.push('schedule:fire');
    return events;
  }, [parsed]);

  // Picker options: the code's own triggers; every event as a fallback when
  // none are detectable (computed `on:`, empty editor). A selection that
  // fell out of the code stays listed — flagged — instead of jumping.
  const eventOptions = useMemo<HookEventName[]>(() => {
    const base = detectedEvents.length > 0 ? detectedEvents : [...HOOK_EVENT_NAMES];
    return base.includes(eventName) ? base : [...base, eventName];
  }, [detectedEvents, eventName]);

  // Follow the code while the user hasn't picked an event themselves.
  useEffect(() => {
    if (eventTouchedRef.current) return;
    const first = detectedEvents[0];
    if (first && first !== eventName) setEventName(first);
  }, [detectedEvents, eventName]);

  const applyCheck = useCallback((result: HookCheckResult) => {
    setDeclared(result.declared);
    setMetaError(
      result.registration && result.registration.buildStatus !== 'ready'
        ? (result.registration.lastError ?? 'The saved script could not be built.')
        : null
    );
  }, []);

  const refreshScheduleId = useCallback(async () => {
    try {
      const schedules = await schedulesApi.list();
      const match = schedules.find((schedule) => isHookSchedule(schedule, hookName));
      setScheduleId(match?.id ?? null);
    } catch {
      // Real-id lookup is best-effort — Trigger now falls back to 'test'.
      setScheduleId(null);
    }
  }, [hookName]);

  // Lazy metadata load on first expand: one check (build if stale + describe)
  // seeds the build-error banner and the Trigger-now schedule id.
  useEffect(() => {
    if (!expanded || metaLoadedRef.current) return;
    metaLoadedRef.current = true;
    hooksWorkspacesApi
      .check(hookName)
      .then(applyCheck)
      .catch((err: unknown) => {
        setMetaError(getErrorMessage(err, "Couldn't check the saved script"));
      });
    void refreshScheduleId();
  }, [expanded, hookName, applyCheck, refreshScheduleId]);

  const runFlow = useCallback(
    async (input: HookRunInput, label: string) => {
      setRunning(true);
      try {
        await ensureSaved();
        const check = await hooksWorkspacesApi.check(hookName);
        applyCheck(check);
        if (check.registration?.buildStatus !== 'ready' || !check.declared) {
          append({
            label: 'check',
            status: 'fail',
            stderr:
              check.registration?.lastError ?? 'The saved script could not be built or registered.',
          });
          return;
        }
        const { runs } = await hooksWorkspacesApi.run(hookName, input);
        for (const run of runs) {
          append({
            label: run.eventName,
            status: run.result.ok ? 'ok' : 'fail',
            // Exactly what the hook received on stdin — the runner appends
            // `type` at delivery (hookRunner.runForTest).
            payload: { ...run.event, type: run.eventName },
            payloadLabel: 'Delivered event',
            stdout: run.result.stdout,
            stderr: run.result.stderr,
            exitCode: run.result.exitCode,
            durationMs: run.result.durationMs,
            timedOut: run.result.timedOut,
          });
        }
        // Entity runs teach the payload shape: mirror the first resolved
        // event into the JSON editor (without `type` — delivery adds that).
        if ((input.nodeIds?.length || input.tableId) && runs[0]) {
          setRawJson(JSON.stringify(runs[0].event, null, 2));
        }
      } catch (err) {
        append({ label, status: 'fail', stderr: getErrorMessage(err, 'Test run failed') });
      } finally {
        setRunning(false);
      }
    },
    [hookName, ensureSaved, applyCheck, append]
  );

  const spec = TRIGGER_PARAM_SPECS[eventName];
  const paramValue = paramsByEvent[eventName] ?? '';
  const setParamValue = useCallback(
    (next: string) =>
      setParamsByEvent((current) =>
        current[eventName] === next ? current : { ...current, [eventName]: next }
      ),
    [eventName]
  );
  const entryIdValue = entryIdsByEvent[eventName] ?? '';
  const setEntryIdValue = useCallback(
    (next: string) =>
      setEntryIdsByEvent((current) =>
        current[eventName] === next ? current : { ...current, [eventName]: next }
      ),
    [eventName]
  );

  const runRawJsonOr = useCallback(
    (onEmpty: () => void) => {
      const trimmed = rawJson.trim();
      if (!trimmed) {
        onEmpty();
        return;
      }
      const parsedJson = safeJsonParse<Record<string, unknown> | null>(trimmed, null);
      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        append({
          label: eventName,
          status: 'fail',
          stderr: 'Event JSON must be a single object, e.g. { "id": "doc-…" }.',
        });
        return;
      }
      void runFlow({ eventName, event: parsedJson }, eventName);
    },
    [rawJson, eventName, runFlow, append]
  );

  const handleRunTest = useCallback(() => {
    if (spec.param === 'table-entry') {
      const tableId = paramValue.trim();
      const entryId = entryIdValue.trim();
      if (tableId && entryId) {
        void runFlow({ tableId, entryId, eventName }, eventName);
        return;
      }
      runRawJsonOr(() => {
        append({
          label: eventName,
          status: 'fail',
          stderr: `${spec.tableLabel} and ${spec.entryLabel} are required — ${spec.hint}`,
        });
      });
      return;
    }
    if (spec.param === 'id') {
      const id = paramValue.trim();
      if (id) {
        void runFlow({ nodeIds: [id], eventName }, eventName);
        return;
      }
      runRawJsonOr(() => {
        append({
          label: eventName,
          status: 'fail',
          stderr: `${spec.label} is required — ${spec.hint}`,
        });
      });
      return;
    }
    if (spec.param === 'node') {
      const refs = extractNodeRefs(paramValue);
      if (refs.length > 0) {
        const wrong = refs.find((ref) => !spec.nodeKinds.includes(ref.kind));
        if (wrong) {
          append({
            label: eventName,
            status: 'fail',
            stderr: `A ${wrong.kind} link can't fire ${eventName} — use a ${spec.label.toLowerCase()} instead.`,
          });
          return;
        }
        void runFlow({ nodeIds: refs.map((ref) => ref.id), eventName }, eventName);
        return;
      }
      // Plain text with no parseable chip: pass tokens through as raw ids
      // (agent slugs, ids the grammar can't see) — the server's validation
      // messages name the exact problem. Skipped when leftover chip
      // markdown is present, which would tokenize into junk.
      const raw = paramValue.trim();
      if (raw && !/[[\]()]/.test(raw)) {
        void runFlow({ nodeIds: raw.split(/[\s,]+/).filter(Boolean), eventName }, eventName);
        return;
      }
      runRawJsonOr(() => {
        append({
          label: eventName,
          status: 'fail',
          stderr: `${spec.label} is required — ${spec.hint}`,
        });
      });
      return;
    }
    // 'none' — schedule:fire. A custom JSON payload still wins when present.
    runRawJsonOr(() => {
      void runFlow({ eventName }, eventName);
    });
  }, [spec, paramValue, entryIdValue, eventName, runFlow, runRawJsonOr, append]);

  // Bare-id drop for the plain id field (run:end and friends).
  //
  // Deliberately a per-surface override rather than a change inside the shared
  // chip utils: every other drop target wants the full chip, this one wants the
  // raw id. The handlers stay local so nothing else inherits the behavior.
  //
  // `handleRunTest`'s id branch feeds `paramValue.trim()` straight to the run
  // endpoint as a node id, so inserting chip markdown here would send
  // `[Name](run:…)` as the id and fail. We take `.id` only.
  const handleIdDragOver = useCallback((e: ReactDragEvent<HTMLInputElement>) => {
    if (!hasChipDragData(e.dataTransfer)) return;
    // Claim the drop so the pane/editor underneath doesn't also handle it.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleIdDrop = useCallback(
    (e: ReactDragEvent<HTMLInputElement>) => {
      const chip = readChipDragData(e.dataTransfer);
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      setParamValue(chip.id);
    },
    [setParamValue]
  );

  const handleTriggerNow = useCallback(() => {
    void runFlow(
      { eventName: 'schedule:fire', event: buildScheduleFireEvent(scheduleId) },
      'schedule:fire'
    );
  }, [runFlow, scheduleId]);

  const busy = disabled || running;
  const hasSchedules = parsed.hasSchedule || (declared?.schedules.length ?? 0) > 0;

  return (
    <BuilderTestConsole
      title="Test console"
      notice="Test runs are real: the saved script runs against the live workspace as the system actor — a script that creates a doc actually creates it."
      entries={entries}
      onClear={clear}
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      controls={
        <div className={consoleStyles.controls}>
          {metaError && (
            <pre className={consoleStyles.controlError} role="alert">
              {metaError}
            </pre>
          )}
          <div className={consoleStyles.controlRow}>
            <label className={consoleStyles.controlField}>
              <span className={consoleStyles.controlLabel}>Trigger</span>
              <Select
                value={eventName}
                onChange={(event) => {
                  eventTouchedRef.current = true;
                  setEventName(event.target.value as HookEventName);
                }}
                disabled={busy}
                aria-label="Test trigger"
              >
                {eventOptions.map((name) => (
                  <option key={name} value={name}>
                    {HOOK_TRIGGER_LABELS[name]}
                    {detectedEvents.length > 0 && !detectedEvents.includes(name)
                      ? ' — not in hook.ts'
                      : ''}
                  </option>
                ))}
              </Select>
              {detectedEvents.length === 0 && (
                <span className={consoleStyles.controlHint}>
                  No `on:` triggers detected in hook.ts — pick any event to test with.
                </span>
              )}
            </label>
          </div>
          {spec.param === 'node' && (
            <div className={consoleStyles.controlField}>
              <span className={consoleStyles.controlLabel}>{spec.label}</span>
              {/* Composer-idiom box: the chip input's plain branch renders an
                  unclassed EditorContent, so layout lives on this block-flow
                  wrapper. */}
              <div className={consoleStyles.chipBox}>
                <ChipEditableInput
                  key={eventName}
                  value={paramValue}
                  onChange={setParamValue}
                  enableNodeMentions
                  disabled={busy}
                  placeholder={spec.placeholder}
                  ariaLabel={`${spec.label} for the test event`}
                  className={consoleStyles.chipInput}
                />
              </div>
              <span className={consoleStyles.controlHint}>{spec.hint}</span>
            </div>
          )}
          {spec.param === 'id' && (
            <div className={consoleStyles.controlField}>
              <span className={consoleStyles.controlLabel}>{spec.label}</span>
              <TextInput
                value={paramValue}
                onChange={(event) => setParamValue(event.target.value)}
                onDragOver={handleIdDragOver}
                onDrop={handleIdDrop}
                disabled={busy}
                placeholder={spec.placeholder}
                aria-label={`${spec.label} for the test event`}
                fullWidth
              />
              <span className={consoleStyles.controlHint}>{spec.hint}</span>
            </div>
          )}
          {spec.param === 'table-entry' && (
            <div className={consoleStyles.controlField}>
              <span className={consoleStyles.controlLabel}>{spec.tableLabel}</span>
              <TextInput
                value={paramValue}
                onChange={(event) => setParamValue(event.target.value)}
                disabled={busy}
                placeholder={spec.tablePlaceholder}
                aria-label={`${spec.tableLabel} for the test event`}
                fullWidth
              />
              <span className={consoleStyles.controlLabel}>{spec.entryLabel}</span>
              <TextInput
                value={entryIdValue}
                onChange={(event) => setEntryIdValue(event.target.value)}
                disabled={busy}
                placeholder={spec.entryPlaceholder}
                aria-label={`${spec.entryLabel} for the test event`}
                fullWidth
              />
              <span className={consoleStyles.controlHint}>{spec.hint}</span>
            </div>
          )}
          {spec.param === 'none' && <span className={consoleStyles.controlHint}>{spec.hint}</span>}
          <div className={consoleStyles.controlField}>
            <span className={consoleStyles.controlLabel}>Event JSON (advanced)</span>
            <Textarea
              unstyled
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              rows={3}
              disabled={busy}
              placeholder='{ "id": "doc-…" }'
              aria-label="Raw event JSON"
              className={consoleStyles.jsonInput}
            />
            <span className={consoleStyles.controlHint}>
              Optional hand-written payload; the {spec.param === 'none' ? 'synthesized' : 'entity'}{' '}
              input above wins when both are set. After an entity run the resolved payload appears
              here so the real shapes are learnable.
            </span>
          </div>
          <div className={consoleStyles.actions}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleRunTest}
              disabled={disabled}
              loading={running}
              loadingText="Running…"
              title="Save the editor, rebuild the script, and run it with the event above"
            >
              Run test
            </Button>
            {hasSchedules && (
              <Button
                variant="neutral"
                size="sm"
                onClick={handleTriggerNow}
                disabled={busy}
                title="Fire a synthesized due-now schedule:fire event, as if the schedule had just come due"
              >
                Trigger now
              </Button>
            )}
            {detectedEvents.length > 0 && (
              <span className={consoleStyles.controlHint}>
                In hook.ts: {detectedEvents.join(', ')}
                {parsed.hasSchedule ? ' · schedule' : ''}
              </span>
            )}
          </div>
        </div>
      }
    />
  );
};
