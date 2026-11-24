/**
 * Alias-scoped tool-access rules.
 *
 * When old tools merge into one `tool(op)` (memory_save + memory_forget →
 * `memory`) or into one tool with a routing param (git_status/git_push →
 * `git{subcommand}`, google_gmail_send → `google_gmail{operation}`), a stored
 * allow/deny entry that names an old id must not change meaning. Plain alias
 * equivalence would widen `allow: memory_save` into all of `memory` (delete
 * included) and `allow: git_status` into `git push`.
 *
 * The rule: narrow allow, broad deny.
 *  - An allow entry naming an old id covers only the calls that old id itself
 *    could make: every param it pins (`op` and any other, see `pins` in
 *    toolAliases) must hold that value on the call.
 *  - A deny entry naming an old id stays as broad as it always was: the op it
 *    pins (or its finite operation family), or the whole tool when it pins no op (`deny: git_push` blocks all of
 *    `git`). Pins other than `op` never narrow a deny, so a pin can only ever
 *    narrow access.
 *  - Entries naming the canonical id (or a pin-less alias) stay tool-wide.
 *  - A tool's own definition names (`aliases` on its definition, e.g. shell's
 *    `bash`/`terminal`) that are not old ids count on the deny side only (see
 *    isPlainNameAlias).
 *  - A tool's display name (`Shell`) names the tool on both sides: an allow
 *    only when it matches exactly, a deny in any case (see ruleNamesTool).
 *
 * No stored data changes.
 */
import {
  resolveToolId as defaultResolve,
  type ResolvedToolId,
  type ToolPins,
  type ToolPinValue,
} from './toolAliases';
import { parseRule } from './toolRules';

/** The param every merged tool uses to select its operation. */
export const TOOL_OP_PARAM = 'op';

const NO_PINS: ToolPins = Object.freeze({});

export interface ScopedRule {
  /** Canonical tool id the rule targets. */
  toolId: string;
  /**
   * Operation the rule is limited to, or null. Both allow and deny rules are
   * scoped to it.
   */
  op: string | null;
  /**
   * Every param the named old id pins, `op` included; empty for a canonical
   * id or a pin-less alias. An allow rule covers only calls carrying all of
   * them. Deny rules ignore every pin but `op`, so a pin can only narrow.
   */
  pins: ToolPins;
  /** Op family of an old multi-operation id, never a whole-tool grant. */
  ops?: readonly string[];
  /** Original specifier text (command/path/sql guard), if any. */
  specifier: string | null;
  /** The stored entry, for user-facing messages. */
  entry: string;
}

export interface OpRuleOptions {
  /** Ids that are live catalog rows; they keep their exact, unaliased meaning. */
  activeToolIds?: ReadonlySet<string>;
  /** Injectable for tests. */
  resolve?: (id: string) => ResolvedToolId;
  /**
   * The (alias-transformed) call input, read for pins other than `op`.
   * Without it only an op pin can match, so a rule pinning anything else does
   * not cover the call (fails closed).
   */
  callParams?: Readonly<Record<string, unknown>>;
}

export function scopeRule(entry: string, options: OpRuleOptions = {}): ScopedRule {
  const rule = parseRule(entry);
  if (options.activeToolIds?.has(rule.toolId)) {
    return { toolId: rule.toolId, op: null, pins: NO_PINS, specifier: rule.specifier, entry };
  }
  const resolution = (options.resolve ?? defaultResolve)(rule.toolId);
  const op = resolution.op ?? null;
  return {
    toolId: resolution.id,
    ...(resolution.ops ? { ops: resolution.ops } : {}),
    op,
    pins: resolution.pins ?? (op !== null ? { [TOOL_OP_PARAM]: op } : NO_PINS),
    specifier: rule.specifier,
    entry,
  };
}

/** True when the entry is an old id that now means one op or a finite family of a merged tool. */
export function isOpScopedEntry(entry: string, options: OpRuleOptions = {}): boolean {
  const rule = scopeRule(entry, options);
  return rule.op !== null || rule.ops !== undefined;
}

/** True when an allow rule is limited to some calls (it names an old id with pins). */
export function isPinScoped(rule: Pick<ScopedRule, 'pins' | 'ops'>): boolean {
  return rule.ops !== undefined || Object.keys(rule.pins).length > 0;
}

/**
 * Whether an allow rule covers one call: each param the rule's old id pins
 * must hold exactly that value on the (alias-transformed) call. `op` is the
 * call's op as readToolOp reads it. A call that omits a pinned param is not
 * covered. A rule with no pins covers every call.
 */
export function allowRuleCoversCall(
  rule: Pick<ScopedRule, 'pins' | 'ops'>,
  op: string | null,
  callParams?: Readonly<Record<string, unknown>>
): boolean {
  if (rule.ops && (op === null || !rule.ops.includes(op))) return false;
  return Object.entries(rule.pins).every(([key, value]) =>
    key === TOOL_OP_PARAM ? op === value : callParams?.[key] === value
  );
}

function pinQualifier(key: string, value: ToolPinValue): string {
  if (value === true) return key;
  return typeof value === 'string' ? `${value} only` : `${key} ${String(value)}`;
}

/**
 * How an allow rule's scope reads, keyed by the param that names it: `op` →
 * `{key:'ops', label:'move (container only)'}`, git_status →
 * `{key:'subcommand', label:'status'}`. Null for a tool-wide rule.
 */
export function describeAllowScope(
  rule: Pick<ScopedRule, 'pins' | 'ops'>
): { key: string; label: string } | null {
  if (rule.ops) return { key: 'ops', label: rule.ops.join(', ') };
  const entries = Object.entries(rule.pins);
  if (entries.length === 0) return null;
  const primary = entries.find(([key]) => key === TOOL_OP_PARAM) ?? entries[0]!;
  const qualifiers = entries
    .filter(([key]) => key !== primary[0])
    .map(([key, value]) => pinQualifier(key, value));
  const label = qualifiers.length
    ? `${String(primary[1])} (${qualifiers.join(', ')})`
    : String(primary[1]);
  return { key: primary[0] === TOOL_OP_PARAM ? 'ops' : primary[0], label };
}

/** `ops: create, search` / `subcommand: status`, for a set of scoped allow rules. */
export function formatAllowScopes(rules: ReadonlyArray<Pick<ScopedRule, 'pins' | 'ops'>>): string {
  const groups = new Map<string, string[]>();
  for (const rule of rules) {
    const scope = describeAllowScope(rule);
    if (!scope) continue;
    const labels = groups.get(scope.key) ?? [];
    if (!labels.includes(scope.label)) labels.push(scope.label);
    groups.set(scope.key, labels);
  }
  return [...groups].map(([key, labels]) => `${key}: ${labels.join(', ')}`).join('; ');
}

/**
 * True when `id` is one of a tool's own definition names (its definition's
 * `aliases`, e.g. shell's `bash`) and carries no meaning of its own: it is not
 * an old id in TOOL_ALIASES (those keep their pins) and not a live tool id.
 * Such a name denies the tool it names everywhere and never allows it, so it
 * can only narrow access.
 */
export function isPlainNameAlias(
  id: string,
  definitionAliases: readonly string[] | null | undefined,
  options: Pick<OpRuleOptions, 'activeToolIds' | 'resolve'> = {}
): boolean {
  if (!definitionAliases || definitionAliases.length === 0) return false;
  const lower = id.toLowerCase();
  if (!definitionAliases.some((alias) => alias.toLowerCase() === lower)) return false;
  if (options.activeToolIds?.has(id)) return false;
  return (options.resolve ?? defaultResolve)(id).aliasedFrom === undefined;
}

/** Which list a rule entry sits in. */
export type ToolRuleSide = 'allow' | 'deny';

/**
 * True when a rule entry's tool id `id` names `tool` by its own id or its
 * display name (`ToolRow.name`, e.g. `Shell` for shell). Every access path
 * reads entries through this one rule: tool visibility, chat dispatch, the
 * action gateway, `/api/tools/execute` and the tool-access editor. Narrow
 * allow, broad deny:
 *  - an allow entry names the tool only when it is the id or the display name
 *    exactly (`allow: Shell` grants shell, `allow: SHELL` grants nothing);
 *  - a deny entry names it by either in any case (`deny: SHELL` blocks shell).
 * Old ids (TOOL_ALIASES) are not read here: they keep their pins (scopeRule).
 * Definition names (`bash`) are not either: they only ever deny
 * (isPlainNameAlias). A live tool id keeps its own meaning.
 */
export function ruleNamesTool(
  id: string,
  tool: { readonly id: string; readonly name?: string | null },
  side: ToolRuleSide,
  options: Pick<OpRuleOptions, 'activeToolIds' | 'resolve'> = {}
): boolean {
  if (id === tool.id) return true;
  if (options.activeToolIds?.has(id)) return false;
  if ((options.resolve ?? defaultResolve)(id).aliasedFrom !== undefined) return false;
  const name = tool.name ?? '';
  if (side === 'allow') return name !== '' && id === name;
  const lower = id.toLowerCase();
  return lower === tool.id.toLowerCase() || (name !== '' && lower === name.toLowerCase());
}

/** Per tool, ops that a deny on an older op also covers (new op -> old op). */
const DENY_AS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  table: { fields: 'read', query: 'read' },
  thread: { add_agents: 'update', remove_agents: 'update' },
};

export type OpVerdict =
  | { decision: 'allow' }
  | { decision: 'deny' | 'ask'; rule?: string; reason: string };

/**
 * Decide whether one call of canonical `toolId` is permitted by its bare deny
 * rules and by alias-scoped allow rules (narrow allow, broad deny; see the
 * module header). Returns allow when no allow rule is scoped, so a tool-wide
 * allow keeps its meaning; the caller's guard engine still runs after it. The
 * deny list applies in every mode; only allow_list reads the allow list.
 */
export function evaluateOpAccess(
  access: { mode: string; allowList: readonly string[]; denyList: readonly string[] },
  toolId: string,
  op: string | null,
  options: OpRuleOptions = {}
): OpVerdict {
  const targets = (list: readonly string[]) =>
    list.map((entry) => scopeRule(entry, options)).filter((rule) => rule.toolId === toolId);

  // Only a BARE deny blocks here. A specifier'd one (e.g. `shell_exec(rm:*)`)
  // is left to the guard engine, which matches the command.
  const deny = targets(access.denyList).filter((rule) => rule.specifier === null);
  // A bare deny that pins no op (the canonical id, a pin-less alias, or an old
  // id that pins only other params, such as git_push) blocks the whole tool:
  // a pin never narrows a deny.
  const toolDeny = deny.find((rule) => rule.op === null && !rule.ops);
  if (toolDeny) {
    return {
      decision: 'deny',
      rule: toolDeny.entry,
      reason: `Blocked by tool-access policy: \`${toolId}\` is denied for you (rule \`${toolDeny.entry}\`).`,
    };
  }
  // New ops split out of an older one must not bypass a deny on it: table's
  // metadata/SQL forms count as read, and thread's add_agents/remove_agents
  // (once fields of update) count as update. This intentionally does not
  // extend scoped allows to the new ops.
  const denyOp = DENY_AS[toolId]?.[op ?? ''] ?? op;
  const denyHit =
    op === null
      ? undefined
      : deny.find(
          (rule) =>
            rule.op === op ||
            rule.ops?.includes(op) ||
            (denyOp !== op &&
              (rule.op === denyOp || (denyOp !== null && rule.ops?.includes(denyOp))))
        );
  if (denyHit) {
    return {
      decision: 'deny',
      rule: denyHit.entry,
      reason: `Blocked by tool-access policy: op \`${op}\` of \`${toolId}\` is denied for you (rule \`${denyHit.entry}\`).`,
    };
  }

  if (access.mode !== 'allow_list') return { decision: 'allow' };
  const allow = targets(access.allowList);
  // A tool-wide allow (canonical id or pin-less alias) covers every call.
  if (allow.length === 0 || allow.some((rule) => !isPinScoped(rule))) return { decision: 'allow' };
  // A scoped allow covers only calls carrying all of its old id's pins:
  // `allow: git_status` is not `allow: git`, and `allow: move_container` does
  // not move a doc.
  const callParams = options.callParams;
  if (allow.some((rule) => allowRuleCoversCall(rule, op, callParams))) {
    return { decision: 'allow' };
  }
  const pinnedKeys = [
    ...new Set(
      allow.flatMap((rule) => [...Object.keys(rule.pins), ...(rule.ops ? [TOOL_OP_PARAM] : [])])
    ),
  ];
  const callShape = pinnedKeys
    .map((key) => {
      const value = key === TOOL_OP_PARAM ? op : callParams?.[key];
      return `${key} \`${value === undefined || value === null ? '(none)' : String(value)}\``;
    })
    .join(', ');
  return {
    decision: 'ask',
    reason: `Not covered by an allow rule: ${callShape} of \`${toolId}\` is not enabled for you. Allowed ${formatAllowScopes(allow)}.`,
  };
}

/** Read the op a (possibly alias-transformed) input selects. */
export function readToolOp(input: Record<string, unknown>): string | null {
  const value = input[TOOL_OP_PARAM];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
