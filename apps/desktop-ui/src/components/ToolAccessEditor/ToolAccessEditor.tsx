import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { isToolAccessEqual } from '@desktop/utils/threadPaneUtils';
import { ALWAYS_AVAILABLE_TOOL_IDS, CORE_TOOL_IDS } from '@snaglet/shared/constants';
import type { ToolAccessConfig, ToolAccessMode, ToolOverride } from '@snaglet/shared/types';
import { Checkbox } from '@desktop/components/controls';
import { Segmented } from '../Segmented';
import { HelpTooltip } from '../Tooltip/HelpTooltip';
import { clearConfirmationOverrides, countConfirmingTools } from './guardedOverrides';
import styles from './ToolAccessEditor.module.scss';
import {
  getErrorMessage,
  parseRule,
  formatRule,
  scopeRule,
  describeAllowScope,
  guardKindFor,
  isPlainNameAlias,
  resolveToolId,
  ruleNamesTool,
  type GuardKind,
  type ToolRuleSide,
} from '@snaglet/shared/utils';

/** Which list an entry sits in: the two read old ids and other names differently. */
type RuleSide = ToolRuleSide;

/**
 * Why a stored entry shows under "Not in the tool list" instead of on a tool:
 * a removed builtin (`sandbox_run`), a live MCP tool that is not connected
 * now, a definition name on the allow side (`allow: bash`, which the server
 * never reads as shell), or an id nothing matches. The rule grammar has no
 * wildcards, so `database_*` is an id like any other and matches nothing.
 * `always` names an always-available tool (search, the clock) by any of its
 * names: the server never gates those, so the entry has no effect. It shows
 * under that tool's row, or in the group when the tool is not listed.
 */
type UnmatchedReason = 'removed' | 'mcp' | 'allow_alias' | 'unknown' | 'always';

/** Tooltip on an always-available tool's locked row. */
const ALWAYS_AVAILABLE_HINT =
  'Always available: agents always have this tool to find tools and tell the time, so no allow or deny entry changes it.';

/**
 * How one stored entry reads in the editor; people only see canonical ids.
 * An old id (an alias kept so stored rules resolve) shows under the tool it
 * names with a "was …" hint. Allow is narrow and deny is broad, as on the
 * server: allow `git_status` covers only subcommand status, while deny
 * `git_push` (which pins no op) blocks all of git. Other names the server
 * reads as the tool get a "saved as …" hint; anything else is `unmatched`.
 * Display only: entries are never rewritten on save, since a pinned old id
 * (`exec_command`) has no canonical spelling and rewriting would widen it.
 */
interface EntryView {
  /** The listed tool it shows on; for `allow_alias`, the tool it names. */
  toolId: string;
  /** `{key:'ops', label:'run'}`, `{key:'subcommand', label:'status'}`; null = whole tool. */
  scope: { key: string; label: string } | null;
  specifier: string | null;
  /** The id as stored, when it is not the tool's own id. */
  aliasedFrom: string | null;
  /** `old` for an old catalog id, `name` for another name of the tool. */
  aliasKind: 'old' | 'name' | null;
  unmatched: UnmatchedReason | null;
}

/** The listed tools, and each one's id and other names (lower-cased) for lookup. */
interface Catalog {
  listed: ReadonlySet<string>;
  byName: ReadonlyMap<string, readonly ToolOption[]>;
}

function buildCatalog(tools: readonly ToolOption[]): Catalog {
  const byName = new Map<string, ToolOption[]>();
  for (const tool of tools) {
    const names = [tool.id, tool.name, ...(tool.aliases ?? [])].map((n) => n.toLowerCase());
    for (const name of new Set(names)) {
      byName.set(name, [...(byName.get(name) ?? []), tool]);
    }
  }
  return { listed: new Set(tools.map((t) => t.id)), byName };
}

/**
 * The listed tool an entry names by another name, as the server reads it.
 * Ids and display names go through the server's own rule (ruleNamesTool):
 * exactly on the allow side, in any case on the deny side. A definition name
 * that is not an old id (isPlainNameAlias) denies its tool and never allows
 * it: `applies` is false.
 */
function namedTool(
  id: string,
  catalog: Catalog,
  side: RuleSide
): { tool: ToolOption; applies: boolean } | null {
  const candidates = catalog.byName.get(id.toLowerCase()) ?? [];
  const byDisplayName = candidates.find((tool) =>
    ruleNamesTool(id, tool, side, { activeToolIds: catalog.listed })
  );
  if (byDisplayName) return { tool: byDisplayName, applies: true };
  const byAlias = candidates.find((tool) =>
    isPlainNameAlias(id, tool.aliases, { activeToolIds: catalog.listed })
  );
  return byAlias ? { tool: byAlias, applies: side === 'deny' } : null;
}

function unmatchedReason(id: string): UnmatchedReason {
  if (resolveToolId(id).removed) return 'removed';
  // Live MCP tools are named `mcp__<server>__<tool>` and listed only while
  // their server is connected.
  return id.startsWith('mcp__') ? 'mcp' : 'unknown';
}

function viewEntry(entry: string, catalog: Catalog, side: RuleSide): EntryView {
  const rule = parseRule(entry);
  const scoped = scopeRule(entry, { activeToolIds: catalog.listed });
  if (catalog.listed.has(scoped.toolId)) {
    const scope =
      side === 'allow'
        ? describeAllowScope(scoped)
        : scoped.op !== null
          ? { key: 'ops', label: scoped.op }
          : null;
    const aliasedFrom = scoped.toolId !== rule.toolId ? rule.toolId : null;
    return {
      toolId: scoped.toolId,
      scope,
      specifier: rule.specifier,
      aliasedFrom,
      aliasKind: aliasedFrom ? 'old' : null,
      unmatched: ALWAYS_AVAILABLE_TOOL_IDS.has(scoped.toolId) ? 'always' : null,
    };
  }
  const named = namedTool(rule.toolId, catalog, side);
  const toolId = named?.tool.id ?? scoped.toolId;
  return {
    toolId,
    scope: null,
    specifier: rule.specifier,
    aliasedFrom: named ? rule.toolId : null,
    aliasKind: named ? 'name' : null,
    unmatched: ALWAYS_AVAILABLE_TOOL_IDS.has(toolId)
      ? 'always'
      : named
        ? named.applies
          ? null
          : 'allow_alias'
        : unmatchedReason(rule.toolId),
  };
}

/** True when a view shows on `toolId`'s row. */
const showsOn = (view: EntryView, toolId: string): boolean =>
  view.unmatched === null && view.toolId === toolId;

/** One "Not in the tool list" row: an entry as stored (trimmed) and why it is there. */
interface UnmatchedEntry {
  text: string;
  label: string;
  hint: string;
  /** The listed always-available tool whose row it shows under, else null (the group). */
  rowToolId: string | null;
}

function describeUnmatched(
  text: string,
  view: EntryView,
  tools: readonly ToolOption[]
): Pick<UnmatchedEntry, 'label' | 'hint'> {
  const id = parseRule(text).toolId;
  switch (view.unmatched) {
    case 'always': {
      const tool = tools.find((t) => t.id === view.toolId);
      return {
        label: 'has no effect — always available',
        hint: `${tool?.name ?? view.toolId} is always available: agents always have it to find tools and tell the time, so this entry changes nothing.`,
      };
    }
    case 'removed':
      return { label: 'removed from Snaglet', hint: resolveToolId(id).removed ?? '' };
    case 'mcp':
      return {
        label: 'MCP tool not connected',
        hint: 'Its MCP server is off or no longer offers this tool. The entry applies again if the tool comes back.',
      };
    case 'allow_alias': {
      const tool = tools.find((t) => t.id === view.toolId);
      return {
        label: 'allows nothing',
        hint: `"${id}" is another name for ${tool?.name ?? view.toolId}. An allow entry must name the tool itself (${view.toolId}), so this one allows nothing.`,
      };
    }
    default:
      return { label: 'no such tool', hint: 'No tool has this id, so the entry has no effect.' };
  }
}

/**
 * How one "Also blocked (deny list)" row reads: the tool it blocks with the
 * main list's reading (an op, a rule), or why it has no effect. The server
 * applies the deny list in every mode (the permission engine, chat dispatch
 * and `/api/tools/execute`), so an entry blocks in All mode as it does here.
 */
function describeAlsoBlocked(
  text: string,
  view: EntryView,
  tools: readonly ToolOption[],
  mode: 'all' | 'allow_list'
): Pick<UnmatchedEntry, 'label' | 'hint'> {
  if (view.unmatched !== null) return describeUnmatched(text, view, tools);
  const name = tools.find((t) => t.id === view.toolId)?.name ?? view.toolId;
  const detail = view.scope
    ? ` · ${view.scope.key}: ${view.scope.label}`
    : view.specifier
      ? ` · ${view.specifier}`
      : '';
  const whole = view.scope === null && view.specifier === null;
  return {
    label: `blocks ${name}${detail}`,
    hint:
      mode === 'all'
        ? `All mode still refuses ${name} ${whole ? 'when an agent calls it' : 'calls this entry matches'}, in a thread or from a script: the deny list applies in every mode.`
        : 'The deny list still applies in allow-list mode: a call this entry matches is refused, even when the tool is allowed.',
  };
}

/** `ops: create, search` or `subcommand: status`, for one tool's scoped entries. */
function scopeTag(views: readonly EntryView[]): string | null {
  if (views.length === 0 || views.some((v) => v.scope === null)) return null;
  const groups = new Map<string, string[]>();
  for (const { scope } of views) {
    if (!scope) continue;
    const labels = groups.get(scope.key) ?? [];
    if (!labels.includes(scope.label)) labels.push(scope.label);
    groups.set(scope.key, labels);
  }
  return [...groups].map(([key, labels]) => `${key}: ${labels.join(', ')}`).join('; ');
}

/** One rule chip on a guarded tool; `aliasedFrom` when stored under an old id. */
interface RuleChip {
  specifier: string;
  aliasedFrom: string | null;
}

/** Tooltip for a chip stored under an old id, naming the entry as saved. */
function savedAsHint(chip: RuleChip): string | undefined {
  if (!chip.aliasedFrom) return undefined;
  return `Saved as ${formatRule({ toolId: chip.aliasedFrom, specifier: chip.specifier })}`;
}

/** Format-hint shown in a guarded tool's "add rule" input, by specifier kind. */
function rulePlaceholder(kind: GuardKind): string {
  if (kind === 'command') return 'git:*   or   pnpm test:*   or   *';
  if (kind === 'path') return '/abs/path/**   or   ~/dir/**';
  return 'select   |   dml   |   ddl   |   *';
}

/** A stored entry shown as text, what it does (hint on hover), and a remove button. */
const EntryRow: FC<{
  text: string;
  label: string;
  hint: string;
  disabled: boolean;
  removeLabel: string;
  onRemove: () => void;
}> = ({ text, label, hint, disabled, removeLabel, onRemove }) => (
  <div className={styles.unmatchedRow}>
    <span className={styles.unmatchedText}>{text}</span>
    <span className={styles.unmatchedReason} title={hint}>
      {label}
    </span>
    <button
      type="button"
      className={styles.chipRemove}
      onClick={onRemove}
      disabled={disabled}
      aria-label={removeLabel}
    >
      ×
    </button>
  </div>
);

export interface ToolOption {
  id: string;
  name: string;
  categoryPath: string;
  description?: string | null;
  /** The definition's other names (shell's `bash`), for reading stored entries. */
  aliases?: readonly string[];
}

interface ToolAccessEditorProps {
  /** Current persisted value to show in the editor. For per-thread overrides,
   *  the caller should resolve "no override → agent default" and pass the
   *  effective value here so the UI reads as the agent will actually behave. */
  value: ToolAccessConfig;
  /** Agent's own default. When set and `allowNull`, a Reset button appears
   *  whenever the current `value` differs from `fallback`. */
  fallback?: ToolAccessConfig;
  tools: ToolOption[];
  /** Persist callback — receives the full pending config. Should throw on
   *  failure (the component catches and renders the error inline). */
  onSave: (next: ToolAccessConfig) => Promise<void>;
  /** When true, exposes a "Reset to default" button that saves `fallback`
   *  (or the empty-default if no fallback) — the caller's onSave can detect
   *  this via `isToolAccessEqual(next, fallback)` and clear the override. */
  allowNull?: boolean;
  headerLabel?: string;
  headerSlot?: ReactNode;
  /** Auto-save mode. When true the Save button is dropped and every change
   *  to the pending config (mode, tool toggles, per-tool rules) persists via
   *  a short debounce that coalesces a rapid burst of toggles into a single
   *  write. Save state + errors surface inline; a failed save keeps the
   *  pending config so a further change re-attempts. Default false preserves
   *  the manual-Save behavior for the thread-override consumer. */
  autosave?: boolean;
  /** The agent's per-tool overrides (`agent.toolOverrides`). Together with
   *  `onSaveToolOverrides`, enables the Guarded indicator + Trusted-mode
   *  action for agents created with guarded confirmation defaults. Omitted by
   *  the per-thread override consumer — thread-level overrides are edited
   *  elsewhere and keep their own precedence. */
  toolOverrides?: Record<string, unknown> | null;
  /** Persist callback for the Trusted-mode clear — receives the overrides map
   *  with every `requiresConfirmation: true` flag removed (null when nothing
   *  is left). Should throw on failure (errors render inline). */
  onSaveToolOverrides?: (next: Record<string, ToolOverride> | null) => Promise<void>;
  /** The agent's persisted trust flag (`agent.trustedToolCalls`). With
   *  `onSaveTrustedToolCalls`, Trusted mode sets this flag instead of clearing
   *  overrides: it suppresses the confirmation prompt for permitted native and
   *  MCP calls, and switching back to guarded keeps the per-tool flags. */
  trustedToolCalls?: boolean;
  /** Persist callback for the trust flag. Should throw on failure. */
  onSaveTrustedToolCalls?: (next: boolean) => Promise<void>;
}

const DEFAULT_VALUE: ToolAccessConfig = { mode: 'all', allowList: [], denyList: [] };
const MODES: Array<{ id: ToolAccessMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'allow_list', label: 'Allow list' },
  { id: 'deny_list', label: 'Deny list' },
];
const FLASH_MS = 1800;
// Debounce for auto-save mode. Long enough to coalesce a burst of toggles
// into one write, short enough that "Saved" lands a beat after the last click.
const AUTOSAVE_MS = 500;

/** Shared editor for per-agent tool access (allow/deny lists + mode), used for
 *  a thread participant override (`allowNull=true`) and an agent's own default.
 *  Presentational: the caller owns persistence. */
export const ToolAccessEditor: FC<ToolAccessEditorProps> = ({
  value,
  fallback,
  tools,
  onSave,
  allowNull = false,
  headerLabel,
  headerSlot,
  autosave = false,
  toolOverrides,
  onSaveToolOverrides,
  trustedToolCalls,
  onSaveTrustedToolCalls,
}) => {
  const [pending, setPending] = useState<ToolAccessConfig>(value);
  const catalog = useMemo(() => buildCatalog(tools), [tools]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Transient per-tool text in the "add rule" inputs (not persisted).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Guarded indicator / Trusted-mode action (agent-level consumer only).
  // Data-driven: "guarded" is simply "some tools ask before running", read
  // straight from the persisted overrides — no duplicated guarded-tool list.
  const confirmingCount = useMemo(() => countConfirmingTools(toolOverrides), [toolOverrides]);
  const [trustArmed, setTrustArmed] = useState(false);
  const [trustSaving, setTrustSaving] = useState(false);

  // Reseed pending state whenever the persisted value's content changes (e.g.
  // a different agent is selected). Compare by content, not reference: parents
  // pass fresh arrays on re-render, and reseeding on those would wipe an
  // in-progress toggle.
  const appliedValueRef = useRef<ToolAccessConfig>(value);
  useEffect(() => {
    if (isToolAccessEqual(appliedValueRef.current, value)) return;
    appliedValueRef.current = value;
    setPending(value);
    setError(null);
    setSavedAt(null);
  }, [value]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const dirty = !isToolAccessEqual(pending, value);
  const hasOverride = allowNull && !isToolAccessEqual(value, fallback ?? DEFAULT_VALUE);

  // The list the current mode operates on (entries may carry a `tool(specifier)`).
  const activeList =
    pending.mode === 'allow_list'
      ? pending.allowList
      : pending.mode === 'deny_list'
        ? pending.denyList
        : [];

  const activeSide: RuleSide = pending.mode === 'deny_list' ? 'deny' : 'allow';
  const activeViews = useMemo(
    () => activeList.map((entry) => viewEntry(entry, catalog, activeSide)),
    [activeList, catalog, activeSide]
  );

  // Tool ids present in the active list (a tool is "checked" if it has any
  // entry: bare, with a specifier, or an old id or other name that names it).
  const activeToolIds = useMemo<Set<string>>(
    () => new Set(activeViews.flatMap((v) => (v.unmatched === null ? [v.toolId] : []))),
    [activeViews]
  );

  // What the scoped entries (old ids that pin an op or another param) grant or
  // block on a tool, shown as "ops: create, search" or "subcommand: status".
  // Null for a tool that also has a tool-wide entry, since that covers it all.
  const scopeTagFor = useCallback(
    (toolId: string): string | null => scopeTag(activeViews.filter((v) => showsOn(v, toolId))),
    [activeViews]
  );

  // Other ids stored for a tool: old ids for the row's "was exec_command"
  // hint, other names for its "saved as bash" hint.
  const aliasesFor = useCallback(
    (toolId: string, kind: 'old' | 'name'): string[] => [
      ...new Set(
        activeViews.flatMap((v) =>
          showsOn(v, toolId) && v.aliasKind === kind && v.aliasedFrom ? [v.aliasedFrom] : []
        )
      ),
    ],
    [activeViews]
  );

  // Stored entries that check no tool, one row per distinct entry: those
  // naming an always-available tool sit under its row, the rest in "Not in
  // the tool list". Left out until the catalog loads: against an empty
  // catalog every entry would read as unmatched.
  const unmatched = useMemo<UnmatchedEntry[]>(() => {
    if (tools.length === 0) return [];
    const seen = new Set<string>();
    const out: UnmatchedEntry[] = [];
    activeList.forEach((entry, i) => {
      const view = activeViews[i]!;
      const text = formatRule(parseRule(entry));
      if (view.unmatched === null || seen.has(text)) return;
      seen.add(text);
      const rowToolId =
        view.unmatched === 'always' && catalog.listed.has(view.toolId) ? view.toolId : null;
      out.push({ text, rowToolId, ...describeUnmatched(text, view, tools) });
    });
    return out;
  }, [activeList, activeViews, catalog, tools]);

  // Distinct rule chips configured for a guarded tool (excludes a bare
  // entry), whether stored under its id or an old one. Deduped so a list that
  // somehow holds the same rule twice (e.g. set via the API) renders one chip
  // with a stable key.
  const specifiersFor = useCallback(
    (toolId: string): RuleChip[] => {
      const seen = new Set<string>();
      const out: RuleChip[] = [];
      for (const v of activeViews) {
        if (!showsOn(v, toolId) || v.specifier === null) continue;
        const key = `${v.aliasedFrom ?? ''} ${v.specifier}`; // ids hold no spaces
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ specifier: v.specifier, aliasedFrom: v.aliasedFrom });
      }
      return out;
    },
    [activeViews]
  );

  // Tools grouped by category path, after the search filter. Sorted by group
  // name then by tool name so the list reads consistently across renders.
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const buckets = new Map<string, ToolOption[]>();
    for (const tool of tools) {
      if (q) {
        const hay = `${tool.name} ${tool.id} ${tool.categoryPath}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const key = tool.categoryPath || 'uncategorized';
      const bucket = buckets.get(key) ?? [];
      bucket.push(tool);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, search]);

  // Stored deny entries, which apply in every mode (see describeAlsoBlocked),
  // one row per distinct entry, so a deny that blocks is never hidden by the
  // mode.
  const alsoBlocked = useMemo<UnmatchedEntry[]>(() => {
    const mode = pending.mode;
    if (mode === 'deny_list' || tools.length === 0) return [];
    const seen = new Set<string>();
    const out: UnmatchedEntry[] = [];
    for (const entry of pending.denyList) {
      const text = formatRule(parseRule(entry));
      if (seen.has(text)) continue;
      const view = viewEntry(entry, catalog, 'deny');
      seen.add(text);
      out.push({ text, rowToolId: null, ...describeAlsoBlocked(text, view, tools, mode) });
    }
    return out;
  }, [pending.mode, pending.denyList, catalog, tools]);

  // The search filters the group's entries by their stored text.
  const shownUnmatched = useMemo(() => {
    const q = search.trim().toLowerCase();
    const inGroup = unmatched.filter((u) => u.rowToolId === null);
    return q ? inGroup.filter((u) => u.text.toLowerCase().includes(q)) : inGroup;
  }, [unmatched, search]);

  const setMode = useCallback((mode: ToolAccessMode) => {
    setPending((prev) => (prev.mode === mode ? prev : { ...prev, mode }));
  }, []);

  const toggleTool = useCallback(
    (toolId: string) => {
      // Locked rows: no entry ever gates an always-available tool.
      if (ALWAYS_AVAILABLE_TOOL_IDS.has(toolId)) return;
      setPending((prev) => {
        if (prev.mode === 'all') return prev;
        const key = prev.mode === 'allow_list' ? 'allowList' : 'denyList';
        const side: RuleSide = key === 'allowList' ? 'allow' : 'deny';
        const list = prev[key];
        const targets = (e: string) => showsOn(viewEntry(e, catalog, side), toolId);
        const has = list.some(targets);
        // Uncheck → drop every entry for this tool (bare + any specifiers + any
        // old ids or other names that show on it — the user explicitly cleared
        // the whole tool).
        // Check → add a bare entry ("any use" in allow mode / "block entirely" in deny mode).
        const next = has ? list.filter((e) => !targets(e)) : [...list, toolId];
        return { ...prev, [key]: next };
      });
    },
    [catalog]
  );

  const addRule = useCallback(
    (toolId: string, rawSpecifier: string) => {
      const specifier = rawSpecifier.trim();
      if (!specifier) return;
      const entry = formatRule({ toolId, specifier });
      setPending((prev) => {
        if (prev.mode === 'all') return prev;
        const key = prev.mode === 'allow_list' ? 'allowList' : 'denyList';
        const side: RuleSide = key === 'allowList' ? 'allow' : 'deny';
        const list = prev[key];
        // A specifier supersedes a bare "any use" entry for the same tool,
        // including one stored under an old id or other name on this row.
        const withoutBare = list.filter((e) => {
          const v = viewEntry(e, catalog, side);
          return !(showsOn(v, toolId) && v.specifier === null);
        });
        if (withoutBare.includes(entry)) return prev;
        return { ...prev, [key]: [...withoutBare, entry] };
      });
    },
    [catalog]
  );

  const removeRule = useCallback(
    (toolId: string, chip: RuleChip) => {
      setPending((prev) => {
        if (prev.mode === 'all') return prev;
        const key = prev.mode === 'allow_list' ? 'allowList' : 'denyList';
        const side: RuleSide = key === 'allowList' ? 'allow' : 'deny';
        // Match by parsed identity, not raw string, so a chip removes its entry
        // even if the stored entry has padding (e.g. `file( /a/** )`) or is
        // stored under an old id (e.g. `exec_command(git:*)` on shell).
        return {
          ...prev,
          [key]: prev[key].filter((e) => {
            const v = viewEntry(e, catalog, side);
            return !(
              showsOn(v, toolId) &&
              v.specifier === chip.specifier &&
              v.aliasedFrom === chip.aliasedFrom
            );
          }),
        };
      });
    },
    [catalog]
  );

  // Drops every copy of an unmatched entry (they share one row), padded or not.
  const removeUnmatched = useCallback((text: string) => {
    setPending((prev) => {
      if (prev.mode === 'all') return prev;
      const key = prev.mode === 'allow_list' ? 'allowList' : 'denyList';
      return { ...prev, [key]: prev[key].filter((e) => formatRule(parseRule(e)) !== text) };
    });
  }, []);

  // An "Also blocked" row's x: drops that entry (every copy) from the deny
  // list, whatever the mode; the allow list is left as stored.
  const removeDenyEntry = useCallback((text: string) => {
    setPending((prev) => ({
      ...prev,
      denyList: prev.denyList.filter((e) => formatRule(parseRule(e)) !== text),
    }));
  }, []);

  const submitDraft = useCallback(
    (toolId: string) => {
      const v = drafts[toolId] ?? '';
      if (!v.trim()) return;
      addRule(toolId, v);
      setDrafts((d) => ({ ...d, [toolId]: '' }));
    },
    [drafts, addRule]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(pending);
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }, [onSave, pending]);

  const handleReset = useCallback(async () => {
    const target = fallback ?? DEFAULT_VALUE;
    setPending(target);
    setSaving(true);
    setError(null);
    try {
      await onSave(target);
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Reset failed'));
    } finally {
      setSaving(false);
    }
  }, [onSave, fallback]);

  // A different agent (or a refreshed record) re-seeds the indicator — an
  // armed are-you-sure from the previous state must not carry over.
  useEffect(() => setTrustArmed(false), [toolOverrides]);

  const handleTrustedMode = useCallback(async () => {
    if (!onSaveToolOverrides && !onSaveTrustedToolCalls) return;
    setTrustSaving(true);
    setError(null);
    try {
      // Flag-based trust keeps the per-tool flags, so "Guarded mode" restores
      // them. Without the flag callback, trust clears the confirmation
      // overrides instead.
      if (onSaveTrustedToolCalls) await onSaveTrustedToolCalls(true);
      else if (onSaveToolOverrides)
        await onSaveToolOverrides(clearConfirmationOverrides(toolOverrides));
      setSavedAt(Date.now());
      setTrustArmed(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Trusted mode failed'));
    } finally {
      setTrustSaving(false);
    }
  }, [onSaveToolOverrides, onSaveTrustedToolCalls, toolOverrides]);

  const handleGuardedMode = useCallback(async () => {
    if (!onSaveTrustedToolCalls) return;
    setTrustSaving(true);
    setError(null);
    try {
      await onSaveTrustedToolCalls(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Guarded mode failed'));
    } finally {
      setTrustSaving(false);
    }
  }, [onSaveTrustedToolCalls]);

  // Flag-based consumers render the trust block whenever the callback is
  // present (a trusted agent has nothing "confirming" to count, and a guarded
  // agent with cleared overrides still inherits MCP server prompts).
  const showTrustBlock = onSaveTrustedToolCalls
    ? true
    : Boolean(onSaveToolOverrides) && confirmingCount > 0;
  const isTrusted = Boolean(onSaveTrustedToolCalls) && trustedToolCalls === true;

  // Auto-save engine (opt-in)
  // Drives off `pending`: any user mutation (mode/toggle/rule) that leaves it
  // differing from the applied `value` arms a debounce, coalescing a burst of
  // toggles into a single write. `savingRef`/`queuedRef` serialize overlapping
  // saves so the last config always ships; a dirty pending is flushed on
  // unmount so a just-toggled change isn't lost on navigate-away.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;

  const runAutosave = useCallback(async () => {
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }
    if (isToolAccessEqual(pendingRef.current, appliedValueRef.current)) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSaveRef.current(pendingRef.current);
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        void runAutosave();
      }
    }
  }, []);

  useEffect(() => {
    if (!autosave) return;
    if (isToolAccessEqual(pending, value)) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosave();
    }, AUTOSAVE_MS);
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [autosave, pending, value, runAutosave]);

  // Unmount flush: a dirty pending toggled within the debounce window would
  // otherwise be dropped when the pane closes. Fire-and-forget through the ref.
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (!autosaveRef.current) return;
      if (savingRef.current) {
        queuedRef.current = true;
        return;
      }
      if (isToolAccessEqual(pendingRef.current, appliedValueRef.current)) return;
      void Promise.resolve(onSaveRef.current(pendingRef.current)).catch((error: unknown) => {
        // Unmount flush: the editor is gone, so there is no surface to show
        // the failure on — log it instead of dropping it.
        console.error('ToolAccessEditor: final unmount save failed', error);
      });
    };
  }, []);

  return (
    <div className={styles.root}>
      {(headerLabel || headerSlot) && (
        <div className={styles.header}>
          {headerLabel && <span className={styles.headerLabel}>{headerLabel}</span>}
          {headerSlot}
        </div>
      )}

      {showTrustBlock && isTrusted && (
        <div className={styles.guardedNotice}>
          <div className={styles.guardedLine}>
            <span className={styles.trustedBadge}>trusted</span>
            <span className={styles.guardedCopy}>
              Runs permitted native and MCP tools without asking. Thread-level rules can still
              require confirmation.
            </span>
          </div>
          <button
            type="button"
            className={styles.trustBtn}
            onClick={() => void handleGuardedMode()}
            disabled={trustSaving}
          >
            {trustSaving ? 'Saving…' : 'Guarded mode'}
          </button>
        </div>
      )}

      {showTrustBlock && !isTrusted && (
        <div className={styles.guardedNotice}>
          <div className={styles.guardedLine}>
            <span className={styles.guardedBadge}>guarded</span>
            <span className={styles.guardedCopy}>
              {onSaveTrustedToolCalls
                ? 'Guarded tools and MCP servers that require confirmation ask before running.'
                : 'Shell, file, and destructive tools ask before running.'}
            </span>
          </div>
          {trustArmed ? (
            <div className={styles.trustConfirm}>
              <span className={styles.trustConfirmText}>
                {onSaveTrustedToolCalls
                  ? 'Let this agent run permitted native and MCP tools without asking?'
                  : 'Let this agent run them without asking?'}
              </span>
              <button
                type="button"
                className={styles.trustConfirmBtn}
                onClick={() => void handleTrustedMode()}
                disabled={trustSaving}
              >
                {trustSaving ? 'Saving…' : 'Confirm'}
              </button>
              <button
                type="button"
                className={styles.trustCancelBtn}
                onClick={() => setTrustArmed(false)}
                disabled={trustSaving}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.trustBtn}
              onClick={() => setTrustArmed(true)}
              disabled={trustSaving}
            >
              Trusted mode
            </button>
          )}
        </div>
      )}

      <Segmented
        value={pending.mode}
        onChange={(next) => setMode(next as ToolAccessMode)}
        size="sm"
        aria-label="Tool access"
        className={styles.modeRow}
      >
        {MODES.map((m) => (
          <Segmented.Option key={m.id} value={m.id} disabled={saving}>
            {m.label}
          </Segmented.Option>
        ))}
      </Segmented>

      {pending.mode === 'all' ? (
        <p className={styles.hint}>
          All tools are callable
          {alsoBlocked.length > 0 ? ', except what the deny list below still blocks' : ''}.{' '}
          {CORE_TOOL_IDS.size} core tools are advertised every turn; the rest are discovered on
          demand.
        </p>
      ) : (
        <>
          <p className={styles.hint}>
            Core tools are advertised by default when access permits.{' '}
            {pending.mode === 'allow_list'
              ? 'Selected on-demand tools are pinned into every turn.'
              : 'Other allowed tools are discovered when needed.'}
          </p>
          <input
            type="search"
            className={styles.search}
            placeholder="Search tools by name or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={saving}
            aria-label="Search tools"
          />
          <div className={styles.list} role="group" aria-label="Tools">
            {shownUnmatched.length > 0 && (
              <div className={styles.group} role="group" aria-label="Not in the tool list">
                <div className={styles.groupLabel}>Not in the tool list</div>
                {shownUnmatched.map((u) => (
                  <EntryRow
                    key={u.text}
                    text={u.text}
                    label={u.label}
                    hint={u.hint}
                    disabled={saving}
                    removeLabel={`Remove ${u.text}`}
                    onRemove={() => removeUnmatched(u.text)}
                  />
                ))}
              </div>
            )}
            {grouped.length === 0 && shownUnmatched.length === 0 ? (
              <div className={styles.empty}>No tools match</div>
            ) : (
              grouped.map(([categoryPath, items]) => (
                <div key={categoryPath} className={styles.group}>
                  <div className={styles.groupLabel}>{categoryPath}</div>
                  {items.map((tool) => {
                    const kind = guardKindFor(tool.id);
                    // Always-available tools are locked: on in allow-list
                    // mode, off in deny-list mode, as the server treats them.
                    const always = ALWAYS_AVAILABLE_TOOL_IDS.has(tool.id);
                    const rowEntries = always
                      ? unmatched.filter((u) => u.rowToolId === tool.id)
                      : [];
                    const checked = always
                      ? pending.mode === 'allow_list'
                      : activeToolIds.has(tool.id);
                    const specs = kind ? specifiersFor(tool.id) : [];
                    const scoped = checked ? scopeTagFor(tool.id) : null;
                    const oldIds = checked ? aliasesFor(tool.id, 'old') : [];
                    const otherNames = checked ? aliasesFor(tool.id, 'name') : [];
                    return (
                      <div key={tool.id} className={styles.rowWrap}>
                        <Checkbox
                          className={`${styles.row} ${checked ? styles.rowChecked : ''}`}
                          checked={checked}
                          onChange={() => toggleTool(tool.id)}
                          disabled={saving || always}
                          title={always ? ALWAYS_AVAILABLE_HINT : undefined}
                        >
                          <span className={styles.rowBody}>
                            <span className={styles.rowTitle}>
                              <span className={styles.rowName}>{tool.name}</span>
                              {always && (
                                <span
                                  className={styles.rowWas}
                                  data-testid={`always-available-${tool.id}`}
                                >
                                  always available
                                </span>
                              )}
                              {scoped && (
                                <span
                                  className={styles.rowOps}
                                  data-testid={`scoped-ops-${tool.id}`}
                                >
                                  {scoped}
                                </span>
                              )}
                              {oldIds.length > 0 && (
                                <span
                                  className={styles.rowWas}
                                  data-testid={`old-ids-${tool.id}`}
                                  title="Saved under an old tool id. It still applies to this tool."
                                >
                                  was {oldIds.join(', ')}
                                </span>
                              )}
                              {otherNames.length > 0 && (
                                <span
                                  className={styles.rowWas}
                                  data-testid={`other-names-${tool.id}`}
                                  title="Saved under another name for this tool. It applies to this tool."
                                >
                                  saved as {otherNames.join(', ')}
                                </span>
                              )}
                              <HelpTooltip
                                ariaLabel={`About ${tool.name}`}
                                label={
                                  <span>
                                    {tool.description || `Tool identifier: ${tool.id}.`}
                                    {CORE_TOOL_IDS.has(tool.id)
                                      ? ' This core tool is advertised every turn.'
                                      : ' This tool is discovered when needed.'}
                                    {kind ? ` Supports scoped ${kind} rules.` : ''}
                                    {always
                                      ? ' Agents always have it, to find tools and tell the time.'
                                      : ''}
                                  </span>
                                }
                              />
                            </span>
                          </span>
                        </Checkbox>

                        {rowEntries.length > 0 && (
                          <div
                            className={styles.rules}
                            role="group"
                            aria-label={`Entries for ${tool.name}`}
                          >
                            {rowEntries.map((u) => (
                              <EntryRow
                                key={u.text}
                                text={u.text}
                                label={u.label}
                                hint={u.hint}
                                disabled={saving}
                                removeLabel={`Remove ${u.text}`}
                                onRemove={() => removeUnmatched(u.text)}
                              />
                            ))}
                          </div>
                        )}

                        {kind && checked && (
                          <div className={styles.rules}>
                            {specs.length > 0 ? (
                              <div className={styles.chips}>
                                {specs.map((chip) => (
                                  <span
                                    key={`${chip.aliasedFrom ?? ''}:${chip.specifier}`}
                                    className={styles.chip}
                                    title={savedAsHint(chip)}
                                  >
                                    <span className={styles.chipText}>{chip.specifier}</span>
                                    <button
                                      type="button"
                                      className={styles.chipRemove}
                                      onClick={() => removeRule(tool.id, chip)}
                                      disabled={saving}
                                      aria-label={`Remove rule ${chip.specifier}`}
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className={styles.rulesHint}>
                                {/* A rule added to a scoped row replaces its bare old-id entry (addRule). */}
                                {pending.mode === 'allow_list'
                                  ? scoped
                                    ? 'only the uses shown are allowed — a rule you add replaces them'
                                    : 'any use allowed — add a rule to restrict'
                                  : scoped
                                    ? 'only the ops shown are blocked — a rule you add replaces them'
                                    : 'blocked entirely — add a rule to limit to specific uses'}
                              </span>
                            )}
                            <div className={styles.addRule}>
                              <input
                                type="text"
                                className={styles.ruleInput}
                                placeholder={rulePlaceholder(kind)}
                                value={drafts[tool.id] ?? ''}
                                onChange={(e) =>
                                  setDrafts((d) => ({ ...d, [tool.id]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    submitDraft(tool.id);
                                  }
                                }}
                                disabled={saving}
                                aria-label={`Add ${kind} rule for ${tool.name}`}
                              />
                              <button
                                type="button"
                                className={styles.addRuleBtn}
                                onClick={() => submitDraft(tool.id)}
                                disabled={saving || !(drafts[tool.id] ?? '').trim()}
                              >
                                Add
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {alsoBlocked.length > 0 && (
        <div className={styles.list} role="group" aria-label="Also blocked (deny list)">
          <div className={styles.group}>
            <div className={styles.groupLabel}>Also blocked (deny list)</div>
            {alsoBlocked.map((u) => (
              <EntryRow
                key={u.text}
                text={u.text}
                label={u.label}
                hint={u.hint}
                disabled={saving}
                removeLabel={`Remove ${u.text} from the deny list`}
                onRemove={() => removeDenyEntry(u.text)}
              />
            ))}
          </div>
        </div>
      )}

      <div className={styles.actions}>
        {!autosave && (
          <button
            type="button"
            className={styles.saveBtn}
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {allowNull && hasOverride && (
          <button type="button" className={styles.resetBtn} disabled={saving} onClick={handleReset}>
            Reset to default
          </button>
        )}
        {autosave && saving && <span className={styles.status}>Saving…</span>}
        {savedAt !== null && !saving && <span className={styles.status}>Saved</span>}
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    </div>
  );
};
