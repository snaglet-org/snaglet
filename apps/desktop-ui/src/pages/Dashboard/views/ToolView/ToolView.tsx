import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { CORE_TOOL_IDS } from '@snaglet/shared/constants';
import type { SnagletAgent } from '@snaglet/shared/types';
import {
  agentsApi,
  toolsApi,
  type ToolAvailability,
  type ToolExecuteResult,
  type ToolRow,
} from '@desktop/utils/api';
import { emitLibraryEvent, onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import { Button, HelpTooltip, Select, Switch } from '@desktop/components';
import { Chip } from '@desktop/components/Chip';
import { EditIcon } from '@desktop/components/Icons';
import styles from './ToolView.module.scss';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';

/**
 * The row the view renders. `availability` is read-time decoration the
 * server adds, so a row can arrive without it: a pane restored from a layout
 * snapshot that saved an undecorated row keeps that row as-is.
 */
type ToolViewRow = Omit<ToolRow, 'availability'> & Partial<Pick<ToolRow, 'availability'>>;

/** The server's verdict for an undecorated row with no integration provider. */
function availabilityOf(tool: ToolViewRow): ToolAvailability {
  return tool.availability ?? (tool.enabled ? 'available' : 'disabled');
}

interface ToolViewProps {
  tool: ToolViewRow;
  /**
   * Present only for workspace-sourced tools (ToolPane gates this by
   * `toolIdFromSource` before passing it down — see that file's doc
   * comment). Renders the Edit button in the header when set; omitted
   * entirely (no button at all) for builtin/mcp tools, which have no
   * folder-backed source for the builder to load.
   */
  onEdit?: () => void;
}

interface ParamField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  defaultValue?: unknown;
  enumValues?: string[];
}

function parseParamFields(schema: Record<string, unknown> | null | undefined): ParamField[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as Record<string, unknown>).properties;
  const required = new Set<string>(
    Array.isArray((schema as Record<string, unknown>).required)
      ? ((schema as Record<string, unknown>).required as unknown[]).filter(
          (v): v is string => typeof v === 'string'
        )
      : []
  );
  const properties = props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
  return Object.entries(properties).map(([name, raw]) => {
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      name,
      type: typeof p.type === 'string' ? p.type : 'string',
      description: typeof p.description === 'string' ? p.description : '',
      required: required.has(name),
      defaultValue: p.default,
      enumValues: Array.isArray(p.enum)
        ? p.enum.filter((value): value is string => typeof value === 'string')
        : undefined,
    };
  });
}

function getFieldInputValue(field: ParamField, values: Record<string, string>): string {
  const current = values[field.name];
  if (current !== undefined) return current;
  if (field.defaultValue === undefined) return '';
  if (typeof field.defaultValue === 'string') return field.defaultValue;
  if (typeof field.defaultValue === 'number' || typeof field.defaultValue === 'boolean') {
    return String(field.defaultValue);
  }
  try {
    return JSON.stringify(field.defaultValue, null, 2);
  } catch {
    return '';
  }
}

function buildToolInput(
  fields: ParamField[],
  values: Record<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    const hasRaw = raw !== undefined && raw !== '';
    if (!hasRaw && field.defaultValue === undefined) continue;
    const v = hasRaw ? raw : field.defaultValue;

    if (field.type === 'boolean') {
      input[field.name] = typeof v === 'boolean' ? v : String(v) === 'true';
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      input[field.name] = typeof v === 'number' ? v : Number(v);
      continue;
    }
    if (field.type === 'object' || field.type === 'array') {
      if (typeof v === 'string') {
        input[field.name] = safeJsonParse<unknown>(v, v);
      } else {
        input[field.name] = v;
      }
      continue;
    }
    input[field.name] = v;
  }
  return input;
}

function formatRunError(err: unknown): string {
  if (err instanceof Error || typeof err === 'string') return getErrorMessage(err);
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return 'Run failed';
  }
}

// The execute route is only mounted when the opt-in unsafe tool-execution
// flag is set server-side (see tools.routes.ts); otherwise POST
// /tools/execute 404s before any handler runs. Every in-handler failure (see
// execution.routes.ts) returns a JSON AppError with its own status, so a 404
// from this call means execution is disabled. Keyed on `FetchError.status`,
// not the message, which differs for a JSON or an HTML 404 body.
function isExecutionDisabledError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
}

const EXECUTION_DISABLED_MESSAGE = 'Tool execution is disabled in this build.';

// A 403 from /tools/execute or /execute/test means panelAuthMiddleware
// rejected the request: missing or invalid X-Snaglet-Panel-Token (see the server's
// middleware/panelAuth.ts). Unlike the 404 case it is usually transient: the
// panel token arrives over the WebSocket shortly after load (see
// ws/WebSocketContext.tsx), so a very early run can 403 and succeed on retry.
// Don't latch a disabled state for it.
function isPanelUnauthorizedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return status === 403;
}

const PANEL_UNAUTHORIZED_MESSAGE =
  'Not authorized to run tools from this panel (missing or invalid panel session token). If this just started, try again in a moment.';

/**
 * Single-tool surface: tool metadata and schema-driven parameter inputs on
 * the left, the latest run's output (or error) on the right, and Run in the
 * bottom strip with the previous run's duration beside it.
 */
export const ToolView: FC<ToolViewProps> = ({ tool, onEdit }) => {
  const fields = useMemo(() => parseParamFields(tool.parametersSchema), [tool.parametersSchema]);
  const isCoreTool = CORE_TOOL_IDS.has(tool.id);

  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Flips true the first time a run comes back as "execute route not
  // mounted" — there's no clean upfront signal for this (it's a
  // security-relevant server flag, not something worth a new endpoint to
  // expose), so we learn it reactively from the first attempt and disable
  // further clicks rather than let someone hit the same disabled state twice.
  const [executionDisabled, setExecutionDisabled] = useState(false);
  const [enabled, setEnabled] = useState(tool.enabled);
  const [availability, setAvailability] = useState(() => availabilityOf(tool));
  const [toggling, setToggling] = useState(false);
  const effectiveEnabled = enabled && availability === 'available';

  // Act-as agent picker — driven by definition-declared metadata on the
  // ToolRow (contextRequirement), never a hardcoded tool-name list here.
  // 'agent-required' → picker is mandatory before Run; 'agent-optional' →
  // offered; absent/'none' → hidden entirely.
  const contextRequirement = tool.contextRequirement ?? 'none';
  const agentRequired = contextRequirement === 'agent-required';
  const showAgentPicker = contextRequirement !== 'none' && !tool.dispatchOnly;
  const [agents, setAgents] = useState<SnagletAgent[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [actAsAgentId, setActAsAgentId] = useState('');
  // Destructive confirm gate (tool.destructive): first Run click arms an
  // inline confirm step; only the explicit Confirm actually POSTs. This is
  // client-side only: /api/tools/execute runs whatever it is sent.
  const [confirmingRun, setConfirmingRun] = useState(false);

  const setParamValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleEnabledToggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    setToggling(true);
    try {
      const updated = await toolsApi.setEnabled(tool.id, next);
      setAvailability(updated.availability);
      // Sync the sidebar list (gray out + sink) and any other open pane.
      emitLibraryEvent({
        type: 'tool-enabled-changed',
        scope: 'tool',
        id: tool.id,
        enabled: next,
        availability: updated.availability,
      });
    } catch (err) {
      setEnabled(!next);
      setError(formatRunError(err));
    } finally {
      setToggling(false);
    }
  }, [tool.id, enabled]);

  useEffect(() => {
    return onLibraryEvent((event) => {
      if (event.type !== 'tool-enabled-changed') return;
      if (event.scope === 'tool' && event.id === tool.id) {
        setEnabled(event.enabled);
        setAvailability(event.availability);
      }
    });
  }, [tool.id]);

  useEffect(() => {
    if (!showAgentPicker) return;
    let canceled = false;
    // Active roster only — per agentsApi.list's contract, pickers must never
    // pass includeArchived.
    agentsApi
      .list()
      .then((rows) => {
        if (canceled) return;
        setAgents([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err) => {
        if (!canceled) setAgentsError(formatRunError(err));
      });
    return () => {
      canceled = true;
    };
  }, [showAgentPicker]);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const input = buildToolInput(fields, values);
      const res = await toolsApi.execute(
        tool.id,
        input,
        actAsAgentId ? { actAsAgentId } : undefined
      );
      setResult(res);
    } catch (err) {
      if (isExecutionDisabledError(err)) {
        setError(EXECUTION_DISABLED_MESSAGE);
        setExecutionDisabled(true);
      } else if (isPanelUnauthorizedError(err)) {
        setError(PANEL_UNAUTHORIZED_MESSAGE);
      } else {
        setError(formatRunError(err));
      }
    } finally {
      setRunning(false);
    }
  }, [tool.id, fields, values, actAsAgentId]);

  // Run affordance: agent-required tools stay blocked until an act-as agent
  // is picked; destructive tools divert through the confirm strip.
  const runBlocked = !effectiveEnabled || (agentRequired && !actAsAgentId);
  const unavailableReason =
    availability === 'unsupported_platform'
      ? 'This tool is only available on macOS.'
      : availability.replace(/_/g, ' ');

  // Merged op tools declare destructiveOps: confirm when the chosen op is one
  // of them, or when no op is chosen yet (the safe direction).
  const destructiveRun =
    tool.destructive === true ||
    (Array.isArray(tool.destructiveOps) &&
      tool.destructiveOps.length > 0 &&
      (!values.op || tool.destructiveOps.includes(values.op)));

  const handleRunClick = useCallback(() => {
    if (destructiveRun) {
      setConfirmingRun(true);
      return;
    }
    void handleRun();
  }, [destructiveRun, handleRun]);

  const handleConfirmRun = useCallback(() => {
    setConfirmingRun(false);
    void handleRun();
  }, [handleRun]);

  const handleReset = useCallback(() => {
    setValues({});
    setResult(null);
    setError(null);
  }, []);

  return (
    <div className={`${styles.root} ${effectiveEnabled ? '' : styles.rootDisabled}`}>
      {/* Compact identity-first header: name + type/exposure inline, description,
          then one quiet meta line — no bordered code fragments. The enable
          switch stays pinned top-right. */}
      <header className={styles.header}>
        <div className={styles.headerLayout}>
          {onEdit && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<EditIcon />}
              onClick={onEdit}
              className={styles.editButton}
              title="Edit this tool's description, schema, and code"
              aria-label="Edit tool"
            >
              Edit
            </Button>
          )}
          <Switch
            size="md"
            className={styles.enableSwitch}
            checked={enabled}
            onChange={handleEnabledToggle}
            disabled={toggling}
            hint={availability.replace(/_/g, ' ')}
            aria-label={enabled ? 'Disable tool for all agents' : 'Enable tool for all agents'}
            title={enabled ? 'Disable tool for all agents' : 'Enable tool for all agents'}
          />

          <div className={styles.headerContent}>
            <div className={styles.titleRow}>
              <h2 className={styles.title}>{tool.name}</h2>
              <span className={styles.kindBadge}>{tool.type}</span>
              <span
                className={`${styles.exposureBadge} ${isCoreTool ? styles.exposureCore : ''}`}
                title={
                  isCoreTool
                    ? 'Advertised to agents on every turn'
                    : 'Discovered by agents when needed'
                }
              >
                {isCoreTool ? 'core' : 'on demand'}
              </span>
            </div>
            {tool.description && <p className={styles.description}>{tool.description}</p>}
            {availability === 'unsupported_platform' && (
              <p className={styles.availabilityNotice} role="status">
                Available on macOS only.
              </p>
            )}
            <div className={styles.meta}>
              <span className={styles.metaItem}>
                <span className={styles.metaKey}>id</span>
                <code className={styles.code}>{tool.id}</code>
              </span>
              <span className={styles.metaItem}>
                <span className={styles.metaKey}>category</span>
                <code className={styles.code}>{tool.categoryPath}</code>
              </span>
              {tool.providerId && (
                <span className={styles.metaItem}>
                  <span className={styles.metaKey}>provider</span>
                  <code className={styles.code}>{tool.providerId}</code>
                </span>
              )}
              {tool.keywords?.length > 0 && (
                <span className={styles.tags}>
                  {tool.keywords.map((kw) => (
                    <Chip key={kw} size="xs" tone="muted">
                      {kw}
                    </Chip>
                  ))}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Two-column body: parameter form left, output console right; stacks
          by container width (not viewport) so split panes behave. Sections
          are label + content. */}
      <div className={styles.body}>
        <section className={styles.paramsCol}>
          <div className={styles.groupLabelRow}>
            <h3 className={styles.groupLabel}>Parameters</h3>
            <span className={styles.groupHint}>
              {fields.length} field{fields.length === 1 ? '' : 's'}
            </span>
          </div>
          {fields.length === 0 ? (
            <p className={styles.empty}>This tool takes no parameters.</p>
          ) : (
            <div className={styles.params}>
              {fields.map((field) => (
                <label key={field.name} className={styles.field}>
                  <div className={styles.fieldLabel}>
                    <span className={styles.fieldName}>
                      {field.name}
                      {field.required && <span className={styles.required}>*</span>}
                      {field.description && (
                        // The description lives in the help tooltip, never in
                        // the input, where a long one would overflow the box.
                        <HelpTooltip
                          label={field.description}
                          ariaLabel={`About ${field.name}`}
                          side="right"
                        />
                      )}
                    </span>
                    <span className={styles.fieldType}>{field.type}</span>
                  </div>
                  {field.enumValues && field.enumValues.length > 0 ? (
                    <Select
                      size="sm"
                      value={getFieldInputValue(field, values)}
                      onChange={(e) => setParamValue(field.name, e.target.value)}
                      aria-label={`${field.name} (${field.type})`}
                    >
                      <option value="">—</option>
                      {field.enumValues.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>
                  ) : field.type === 'boolean' ? (
                    <Select
                      size="sm"
                      value={getFieldInputValue(field, values)}
                      onChange={(e) => setParamValue(field.name, e.target.value)}
                    >
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : field.type === 'object' || field.type === 'array' ? (
                    // JSON params. `passIdOnly` serializes
                    // chips as bare ids (the tool runtime expects the
                    // id, not a wiki-link), and `allowInlineParse`
                    // exposes the `↳` toggle so a doc chip can be
                    // flagged for runtime content-expansion.
                    <ChipEditableInput
                      value={getFieldInputValue(field, values)}
                      onChange={(next) => setParamValue(field.name, next)}
                      placeholder={`${field.type} as JSON`}
                      multiline
                      passIdOnly
                      allowInlineParse
                      ariaLabel={`${field.name} (${field.type})`}
                      className={`${styles.input} ${styles.textarea}`}
                    />
                  ) : field.type === 'number' || field.type === 'integer' ? (
                    // Number/integer: a numeric `<input type="number">`
                    // for native typing and the spinner. A dropped chip
                    // lands as its bare id (passIdOnly) so the tool can
                    // still resolve it, shown as text, not a pill.
                    <input
                      className={styles.input}
                      type="number"
                      value={getFieldInputValue(field, values)}
                      onChange={(e) => setParamValue(field.name, e.target.value)}
                    />
                  ) : (
                    // String param. Same `passIdOnly +
                    // allowInlineParse` config as JSON, single-line.
                    <ChipEditableInput
                      value={getFieldInputValue(field, values)}
                      onChange={(next) => setParamValue(field.name, next)}
                      passIdOnly
                      allowInlineParse
                      ariaLabel={`${field.name} (${field.type})`}
                      className={styles.input}
                    />
                  )}
                </label>
              ))}
            </div>
          )}

          {showAgentPicker && (
            <label className={styles.field}>
              <div className={styles.fieldLabel}>
                <span className={styles.fieldName}>
                  Act as agent
                  {agentRequired && <span className={styles.required}>*</span>}
                </span>
                <span className={styles.fieldType}>agent</span>
              </div>
              <Select
                size="sm"
                value={actAsAgentId}
                onChange={(e) => setActAsAgentId(e.target.value)}
                aria-label="Act as agent"
              >
                <option value="">{agentRequired ? 'Select an agent…' : '— no agent —'}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <span className={styles.fieldHelp}>
                {agentRequired
                  ? 'This tool operates on per-agent state — pick the agent to run it as.'
                  : 'Optional: run with this agent’s context (memory scoping, per-agent integrations).'}
              </span>
              {agentsError && <span className={styles.fieldHelp}>{agentsError}</span>}
            </label>
          )}

          {tool.dispatchOnly ? (
            // Metadata-driven (definition.ts → dispatchOnly): no Run at all —
            // this tool only functions where the socket dispatch loop
            // intercepts it or injects its dependencies.
            <p className={styles.dispatchOnlyNote}>
              This tool only runs inside a live agent conversation — the dispatch layer provides
              behavior the panel can’t, so it can’t be invoked from here.
            </p>
          ) : confirmingRun ? (
            <div className={styles.confirmStrip} role="alert">
              <span className={styles.confirmText}>
                This tool is flagged destructive — its effects may be irreversible. Run it?
              </span>
              <div className={styles.confirmActions}>
                <Button variant="danger" size="md" onClick={handleConfirmRun}>
                  Confirm Run
                </Button>
                <Button variant="neutral" size="md" onClick={() => setConfirmingRun(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button
                variant="primary"
                size="md"
                leftIcon={<span aria-hidden>▶</span>}
                onClick={handleRunClick}
                loading={running}
                loadingText="Running…"
                disabled={executionDisabled || runBlocked}
                title={
                  executionDisabled
                    ? EXECUTION_DISABLED_MESSAGE
                    : !effectiveEnabled
                      ? unavailableReason
                      : runBlocked
                        ? 'Pick an act-as agent to run this tool'
                        : undefined
                }
              >
                Run
              </Button>
              <Button variant="neutral" size="md" onClick={handleReset} disabled={running}>
                Reset
              </Button>
              {result && !running && <span className={styles.duration}>{result.durationMs}ms</span>}
            </div>
          )}

          {tool.parametersSchema && Object.keys(tool.parametersSchema).length > 0 && (
            <details className={styles.schemaDetails}>
              <summary className={styles.schemaSummary}>Raw parameters schema</summary>
              <pre className={styles.schemaPre}>
                {JSON.stringify(tool.parametersSchema, null, 2)}
              </pre>
            </details>
          )}
        </section>

        <section className={styles.outputCol}>
          <div className={styles.groupLabelRow}>
            <h3 className={styles.groupLabel}>Output</h3>
            {result && (
              <span
                className={`${styles.statusChip} ${
                  result.success ? styles.statusOk : styles.statusFail
                }`}
              >
                {result.success ? 'success' : 'failed'}
              </span>
            )}
            {error && <span className={`${styles.statusChip} ${styles.statusFail}`}>error</span>}
          </div>
          <div className={styles.output}>
            {!result && !error && (
              <pre className={styles.outputEmpty}>
                {`> waiting for run…\n> click ▶ Run to invoke ${tool.id}`}
              </pre>
            )}
            {error && <pre className={styles.outputError}>{error}</pre>}
            {result && (
              <pre className={result.success ? styles.outputOk : styles.outputError}>
                {result.output || result.error || '(no output)'}
              </pre>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
