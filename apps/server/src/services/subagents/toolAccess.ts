/**
 * A helper's tool access, derived from its orchestrator's. Pure, so the rules
 * are testable on their own.
 *
 * Every comparison reads a rule entry the way the permission engine does
 * (identifiersMatch → ruleNamesTool): a tool's id, its display name (exactly
 * on the allow side, in any case on the deny side), an old id through the
 * alias map (keeping its pins), and on the deny side a plain definition name
 * (`bash` for shell). An entry no catalog tool answers to (an MCP id, an id
 * the catalog does not know) names only itself, so with an empty catalog the
 * rules fall back to comparing ids. Every rule here only ever drops entries
 * or keeps the narrower of two: a helper's access is never wider than its
 * orchestrator's.
 */
import type { AgentRow } from '@snaglet/db/tables/agents';
import { SUBAGENT_DENIED_TOOL_IDS } from '@snaglet/shared/constants';
import {
  isPinScoped,
  isPlainNameAlias,
  resolveToolId,
  scopeRule,
  type ToolRuleSide,
} from '@snaglet/shared/utils';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { MCP_PREFIX } from '@server/services/McpService/mcpTypes';
import { parseRule } from '@server/services/ToolService/lib/toolPermission';
import { identifiersMatch } from '@server/services/ToolService/lib/toolVisibility';
import { SubagentError } from './errors';

/** The live tools rule entries are read against: their ids and names. */
export interface ToolNameCatalog {
  /** Live tool ids: an entry naming one keeps that exact meaning. */
  activeToolIds: ReadonlySet<string>;
  tools: ReadonlyArray<{
    id: string;
    /** Display name (`Shell`); '' for none. */
    name: string;
    aliases?: readonly string[] | null;
  }>;
}

export const EMPTY_TOOL_NAME_CATALOG: ToolNameCatalog = { activeToolIds: new Set(), tools: [] };

/** A live MCP tool id (`mcp__<server>__<tool>`). */
export function isMcpToolEntry(entry: string): boolean {
  return parseRule(entry).toolId.startsWith(MCP_PREFIX);
}

/**
 * The tool ids an entry's tool id names on `side`. An MCP id is matched
 * exactly: an MCP tool's display name is the server's raw tool name, which
 * can equal a builtin id or another server's tool.
 */
function namedTools(
  entryToolId: string,
  side: ToolRuleSide,
  catalog: ToolNameCatalog
): ReadonlySet<string> {
  const named = new Set<string>();
  if (!entryToolId.startsWith(MCP_PREFIX)) {
    const options = { activeToolIds: catalog.activeToolIds };
    for (const tool of catalog.tools) {
      if (
        identifiersMatch(entryToolId, tool, catalog.activeToolIds, side) ||
        (side === 'deny' && isPlainNameAlias(entryToolId, tool.aliases, options))
      ) {
        named.add(tool.id);
      }
    }
  }
  if (named.size === 0) {
    // The alias map is static, so an old id still names its tool when the
    // catalog lacks it (the registry not loaded yet).
    const resolution = catalog.activeToolIds.has(entryToolId) ? null : resolveToolId(entryToolId);
    named.add(resolution?.aliasedFrom !== undefined ? resolution.id : entryToolId);
  }
  return named;
}

function overlaps(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const id of left) if (right.has(id)) return true;
  return false;
}

function isSubset(inner: ReadonlySet<string>, outer: ReadonlySet<string>): boolean {
  for (const id of inner) if (!outer.has(id)) return false;
  return true;
}

/**
 * How far an allow entry reaches into its tool: null for the whole tool, else
 * a key for its scope (an old id's pins, a specifier). Two entries with the
 * same key allow the same calls.
 */
function allowScope(entry: string, catalog: ToolNameCatalog): string | null {
  const rule = scopeRule(entry, { activeToolIds: catalog.activeToolIds });
  if (rule.specifier === null && !isPinScoped(rule)) return null;
  const pins = Object.entries(rule.pins).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([rule.specifier, pins, rule.ops]);
}

/**
 * Whether a bare deny in `denyList` removes a tool `entry` names entirely (a
 * deny that names one op of a merged tool leaves the rest, and a specifier'd
 * deny is judged per call; both still apply, since every base deny is kept).
 */
function wholeToolDenied(
  entry: string,
  denyList: readonly string[],
  catalog: ToolNameCatalog
): boolean {
  const tools = namedTools(parseRule(entry).toolId, 'allow', catalog);
  return denyList.some((deny) => {
    const rule = parseRule(deny);
    if (rule.specifier !== null) return false;
    const scoped = scopeRule(deny, { activeToolIds: catalog.activeToolIds });
    if (scoped.op !== null || scoped.ops) return false;
    return overlaps(namedTools(rule.toolId, 'deny', catalog), tools);
  });
}

interface AllowGrant {
  entry: string;
  tools: ReadonlySet<string>;
  scope: string | null;
  rule: ReturnType<typeof scopeRule>;
}

function allowGrant(entry: string, catalog: ToolNameCatalog): AllowGrant {
  return {
    entry,
    tools: namedTools(parseRule(entry).toolId, 'allow', catalog),
    scope: allowScope(entry, catalog),
    rule: scopeRule(entry, { activeToolIds: catalog.activeToolIds }),
  };
}

/** Whether every call `inner` allows, `outer` allows too. */
function grantWithin(inner: AllowGrant, outer: AllowGrant): boolean {
  if (!isSubset(inner.tools, outer.tools)) return false;
  if (outer.scope === null || inner.scope === outer.scope) return true;
  // A single-op alias (or smaller family) is within a history-family grant.
  // Specifiers must be identical; otherwise keep the conservative intersection.
  const outerOps = outer.rule.ops;
  if (outerOps && inner.rule.specifier === outer.rule.specifier) {
    const innerOps = inner.rule.ops ?? (inner.rule.op ? [inner.rule.op] : []);
    return (
      innerOps.length > 0 &&
      innerOps.every((op) => outerOps.includes(op)) &&
      Object.entries(outer.rule.pins).every(([key, value]) => inner.rule.pins[key] === value)
    );
  }
  return false;
}

/**
 * Base allow entries ∩ own allow entries. For each pair that names a common
 * tool, the entry that lies within the other is kept, the base entry when
 * they are equal: `git` ∩ `git_status` keeps `git_status`, `shell(git:*)` ∩
 * `Shell` keeps `shell(git:*)`. A pair where neither lies within the other
 * (two different scopes of one tool) keeps nothing: what both allow cannot
 * be written as an entry. A kept entry therefore never allows a call its
 * pair's other entry refuses. An own MCP id passes through: allow lists do
 * not gate MCP tools (server enablement does), so it widens nothing; it
 * carries the helper's MCP limit and pins the tool's schema.
 */
function intersectAllowLists(
  base: readonly string[],
  own: readonly string[],
  catalog: ToolNameCatalog
): string[] {
  const kept: string[] = [];
  const ownGrants = own
    .filter((entry) => !isMcpToolEntry(entry))
    .map((entry) => allowGrant(entry, catalog));
  for (const baseEntry of base) {
    const b = allowGrant(baseEntry, catalog);
    for (const o of ownGrants) {
      if (!overlaps(o.tools, b.tools)) continue;
      if (grantWithin(b, o)) kept.push(b.entry);
      else if (grantWithin(o, b)) kept.push(o.entry);
    }
  }
  kept.push(...own.filter(isMcpToolEntry));
  return [...new Set(kept)];
}

/** Whether an entry names a tool no helper may have (any case, old ids, definition names). */
function namesHelperDeniedTool(entry: string, catalog: ToolNameCatalog): boolean {
  const tools = namedTools(parseRule(entry).toolId, 'deny', catalog);
  for (const id of SUBAGENT_DENIED_TOOL_IDS) if (tools.has(id)) return true;
  return false;
}

export interface HelperToolAccessOptions {
  catalog?: ToolNameCatalog;
  /**
   * The MCP servers the orchestrator can use in the parent thread. A listed
   * MCP tool must belong to one of them.
   */
  mcpServerIds?: readonly string[];
}

/**
 * The orchestrator's effective access in its thread (a participant override
 * replaces the agent's own), narrowed to `tools`, with the helper-denied set
 * removed (the resolver also strips that set from every helper). With
 * `tools`, the result is the allow list stored on the helper row: the listed
 * entries the orchestrator can use, as written; an empty result is refused.
 */
export function helperToolAccess(
  base: ToolAccessConfig,
  tools: readonly string[] | null | undefined,
  options: HelperToolAccessOptions = {}
): Pick<AgentRow, 'toolAccessMode' | 'toolAccessAllowList' | 'toolAccessDenyList'> {
  const denied = SUBAGENT_DENIED_TOOL_IDS;
  const catalog = options.catalog ?? EMPTY_TOOL_NAME_CATALOG;
  if (tools && tools.length > 0) {
    const mcpServers = options.mcpServerIds ?? [];
    const listed = [...new Set(tools.map((t) => t.trim()).filter(Boolean))];
    const allowed = listed.filter((entry) => {
      if (wholeToolDenied(entry, base.denyList, catalog)) return false;
      if (isMcpToolEntry(entry)) {
        const id = parseRule(entry).toolId;
        return mcpServers.some((server) => id.startsWith(`${MCP_PREFIX}${server}__`));
      }
      if (namesHelperDeniedTool(entry, catalog)) return false;
      if (base.mode !== 'allow_list') return true;
      return intersectAllowLists(base.allowList, [entry], catalog).length > 0;
    });
    if (allowed.length === 0) {
      throw new SubagentError(
        'tools: none of the listed tools are available to you (or they are tools a subagent cannot have).'
      );
    }
    return { toolAccessMode: 'allow_list', toolAccessAllowList: allowed, toolAccessDenyList: null };
  }
  if (base.mode === 'allow_list') {
    return {
      toolAccessMode: 'allow_list',
      toolAccessAllowList: base.allowList.filter((t) => !denied.has(t)),
      toolAccessDenyList: null,
    };
  }
  const deny = new Set(base.mode === 'deny_list' ? base.denyList : []);
  for (const t of denied) deny.add(t);
  return { toolAccessMode: 'deny_list', toolAccessAllowList: null, toolAccessDenyList: [...deny] };
}

export function agentToolAccess(agent: AgentRow): ToolAccessConfig {
  const mode = agent.toolAccessMode;
  return {
    mode: mode === 'allow_list' || mode === 'deny_list' ? mode : 'all',
    allowList: agent.toolAccessAllowList ?? [],
    denyList: agent.toolAccessDenyList ?? [],
  };
}

/**
 * A helper's access right now: its orchestrator's current access (`base`),
 * narrowed by the helper's own stored setting. Helpers inherit live,
 * so their row holds only the narrowing chosen at start: an allow list of the
 * tools it may use (op:start `tools`), or nothing. Never wider than `base`:
 * against a base allow list the narrower entry of each matching pair is kept
 * (specifiers such as `shell(git:*)` survive); against an All or deny-list
 * base the listed entries are kept as written, minus tools a bare deny removes;
 * and base denies always carry over. A deny list on the row (helpers created
 * before live inheritance) only adds denies. The helper-denied tools are
 * stripped later, at resolution.
 */
export function narrowToolAccess(
  base: ToolAccessConfig,
  own: ToolAccessConfig,
  catalog: ToolNameCatalog = EMPTY_TOOL_NAME_CATALOG
): ToolAccessConfig {
  if (own.mode === 'allow_list') {
    const allowList =
      base.mode === 'allow_list'
        ? intersectAllowLists(base.allowList, own.allowList, catalog)
        : [...new Set(own.allowList)].filter(
            (entry) => !wholeToolDenied(entry, base.denyList, catalog)
          );
    return { mode: 'allow_list', allowList, denyList: [...base.denyList] };
  }
  if (own.mode === 'deny_list' && own.denyList.length > 0) {
    const denyList = [...new Set([...base.denyList, ...own.denyList])];
    return base.mode === 'allow_list'
      ? { mode: 'allow_list', allowList: [...base.allowList], denyList }
      : { mode: 'deny_list', allowList: [], denyList };
  }
  return { mode: base.mode, allowList: [...base.allowList], denyList: [...base.denyList] };
}

/**
 * The MCP tool ids a helper's own narrowing lists, or null when it has none
 * (it then gets every MCP tool its orchestrator has). Exact ids only.
 */
export function helperMcpLimit(own: ToolAccessConfig): ReadonlySet<string> | null {
  if (own.mode !== 'allow_list') return null;
  return new Set(own.allowList.filter(isMcpToolEntry).map((entry) => parseRule(entry).toolId));
}

/**
 * Whether `access` lets an agent use the whole of `toolId` (bare rules;
 * specifiers are judged per call). A tool-wide bare deny naming it says no;
 * in allow-list mode an entry must name it, and an old id that allows one op
 * of it does not count.
 */
export function accessAllowsTool(
  access: ToolAccessConfig,
  toolId: string,
  catalog: ToolNameCatalog = EMPTY_TOOL_NAME_CATALOG
): boolean {
  if (wholeToolDenied(toolId, access.denyList, catalog)) return false;
  if (access.mode !== 'allow_list') return true;
  return access.allowList.some((entry) => {
    const rule = scopeRule(entry, { activeToolIds: catalog.activeToolIds });
    if (isPinScoped(rule)) return false;
    return namedTools(parseRule(entry).toolId, 'allow', catalog).has(toolId);
  });
}
