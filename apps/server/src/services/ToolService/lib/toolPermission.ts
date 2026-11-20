/**
 * toolPermission: call-time permission checks for the "computer" tools (shell,
 * file write/edit/patch, raw SQL), enforced only in ToolAccessConfig modes
 * 'allow_list' and 'deny_list' ('all' is the trusted tier). Entries are rules
 * with an optional specifier: `shell_exec(git:*)` (command prefix),
 * `file_write(/proj/**)` (path glob), `database_execute(select:*)` (SQL type);
 * a bare entry matches any call. Precedence: deny > allow > default, which is
 * 'ask' for allow_list (denied when headless) and 'allow' for deny_list. An
 * allow prefix never covers a chained command; paths resolve before matching.
 */

import path from 'path';
import os from 'os';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { expandHome } from '@server/utils/paths';
import { getShellSessionPendingLine } from '../tools/shell/codex-shell-sessions';
import { stdinCommandLines } from '../tools/shell/stdinLines';
import {
  guardKindFor,
  parseRule,
  formatRule,
  resolveToolId,
  transformToolAliasParams,
  evaluateOpAccess,
  readToolOp,
  scopeRule,
  allowRuleCoversCall,
  isPlainNameAlias,
  ruleNamesTool,
  type GuardKind,
  type ParsedRule,
} from '@snaglet/shared/utils';
import { isAlwaysAvailableTool } from './alwaysAvailableTools';

// The rule grammar (which tools are guarded, parsing, formatting) is shared with
// the UI editor — re-export so server-side importers keep their import path.
export { isGuardedTool, parseRule, formatRule } from '@snaglet/shared/utils';

type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Tools that run shell commands and share the git command-specifier namespace. */
const SHELL_TOOL_IDS: ReadonlySet<string> = new Set(['shell', 'shell_exec', 'exec_command']);

/**
 * Ops of a guarded op tool that carry no guarded argument. shell(op:write)
 * is not one: every line it types is a command, see shellTargets.
 */
export const UNGUARDED_OPS: Readonly<Record<string, ReadonlySet<string>>> = {
  // file: only create/update write; read/list/info/diff are not guarded.
  file: new Set(['read', 'list', 'info', 'diff']),
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Pull every file path a `*** Begin Patch` body touches (Add/Update/Delete/Move
 * File lines), plus the rename destination. Best-effort: anything we can't parse
 * is ignored, which only ever makes the check more permissive for unparseable
 * lines — acceptable because an unparseable patch tends to fail to apply anyway,
 * and the apply itself still runs under the same agent cwd.
 */
function extractPatchPaths(input: Record<string, unknown>): string[] {
  // Mirror apply-patch's own input resolution (patch ?? input ?? content) so a
  // patch passed via any accepted field is still authorized.
  const patch = str(input.patch ?? input.input ?? input.content);
  const workdir = str(input.workdir);
  const out: string[] = [];
  const re = /^\*\*\*\s+(Add|Update|Delete|Move)\s+File:\s+(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    out.push(m[2] ?? '');
  }
  // Update with a rename: "*** Move to: <dest>"
  const moveRe = /^\*\*\*\s+Move\s+to:\s+(.+?)\s*$/gim;
  while ((m = moveRe.exec(patch)) !== null) {
    out.push(m[1] ?? '');
  }
  // Resolve relative patch paths against the declared workdir when present so
  // the path matcher sees the same absolute form the apply will write to.
  return out.map((p) => (workdir && !path.isAbsolute(p) ? path.join(workdir, p) : p));
}

/**
 * shell(op): op-independent so a decoy field only adds targets. `cmd` when
 * present, plus every line `chars` would submit to the session, joined with
 * the session's unfinished line (stdinCommandLines, shared with the git rail).
 * Empty `chars` (a poll) adds nothing; no target at all yields [''] upstream,
 * which only a bare rule matches. Known race, accepted for a rail: the pending
 * line is read at verdict time, so after an `ask` approval another write may
 * change what is finally submitted. The git rail re-checks at write time.
 */
function shellTargets(i: Record<string, unknown>): string[] {
  const out: string[] = [];
  const cmd = str(i.cmd ?? i.command).trim();
  if (cmd) out.push(cmd);
  if (i.chars !== undefined && i.chars !== null && str(i.chars) !== '') {
    const sessionId = Number(i.session_id);
    const pending = Number.isInteger(sessionId) ? getShellSessionPendingLine(sessionId) : '';
    out.push(...stdinCommandLines(pending, str(i.chars)).lines);
  }
  return out;
}

/**
 * Per-tool argument extractors — the security-relevant string(s) to authorize
 * for each guarded tool. Which tools are guarded and their specifier kind live
 * in GUARDED_TOOL_KINDS (shared with the UI); this map adds the runtime
 * extraction the engine needs. Returns one string per thing to authorize
 * (usually one; apply_patch yields one per file it touches).
 */
const EXTRACTORS: Record<string, (input: Record<string, unknown>) => string[]> = {
  shell: shellTargets,
  shell_exec: (i) => [str(i.command).trim()],
  exec_command: (i) => [str(i.cmd ?? i.command).trim()],
  // file(op): guard everything the call could write, whatever the op: `path`
  // when present, plus every file a `patch` touches. Op-independent on purpose,
  // so a decoy field can never steer the guard away from what the handler
  // writes (only `patch` is parsed, never `content`, which may hold any text).
  file: (i) => {
    const out: string[] = [];
    if (i.path !== undefined && i.path !== null) out.push(str(i.path));
    if (i.patch !== undefined && i.patch !== null) {
      out.push(...extractPatchPaths({ patch: i.patch, workdir: i.workdir }));
    }
    return out;
  },
  file_write: (i) => [str(i.path)],
  file_edit: (i) => [str(i.path)],
  apply_patch: extractPatchPaths,
  database_execute: (i) => [str(i.sql).trim()],
  // database_query runs raw SQL too (as the read-only snaglet_workspace_reader role);
  // it sits under the same SQL policy so one rule can govern both tools.
  database_query: (i) => [str(i.sql).trim()],
  git: (i) => {
    const subcommand = str(i.subcommand).trim();
    const tail = [i.action, i.ref, i.remote, i.branch, i.name, i.commit, i.path]
      .map(str)
      .map((value) => value.trim())
      .filter(Boolean);
    return [[`git`, subcommand, ...tail].filter(Boolean).join(' ')];
  },
};

/**
 * Shell control operators that let a command chain into a second command. A
 * prefix allow rule must not authorize a command that contains any of these,
 * otherwise `shell_exec(git:*)` would green-light `git log && rm -rf ~`.
 */
const SHELL_CHAIN_RE = /(\|\||&&|;|\||`|\$\(|\n|\r|>|<|&)/;

export function hasShellChaining(command: string): boolean {
  return SHELL_CHAIN_RE.test(command);
}

/** Collapse runs of whitespace so `rm  -rf` and `rm -rf` compare equal. */
function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

/** Strip leading `VAR=value` env assignments (e.g. `FOO=bar git ...` → `git ...`). */
function stripEnvAssignments(cmd: string): string {
  return cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
}

/**
 * Match a command against a specifier: "*" (any), "git status" (exact), or
 * "git:*" (exactly `git` or starting with `git `). For an allow rule
 * (`allowContext`), a prefix match also requires no chaining operators, and the
 * command is matched as written, so a leading env assignment (`LD_PRELOAD=…`)
 * falls through to ask. Deny rules ignore chaining and strip leading env
 * assignments, so `FOO=bar rm …` is still caught by `deny shell_exec(rm:*)`.
 * Deny matching is best-effort: an absolute argv0 (`/bin/rm`) still evades a
 * `rm:*` deny, so prefer allow lists.
 */
export function matchCommand(specifier: string, command: string, allowContext: boolean): boolean {
  const spec = specifier.trim();
  if (spec === '*') return true;
  const cmd = allowContext
    ? normalizeCommand(command)
    : normalizeCommand(stripEnvAssignments(normalizeCommand(command)));
  if (spec.endsWith(':*')) {
    const prefix = normalizeCommand(spec.slice(0, -2));
    if (prefix.length === 0) return true;
    const prefixMatches = cmd === prefix || cmd.startsWith(prefix + ' ');
    if (!prefixMatches) return false;
    return allowContext ? !hasShellChaining(cmd) : true;
  }
  return cmd === normalizeCommand(spec);
}

/**
 * Convert a path glob into an anchored regex with a single left-to-right pass
 * (so inserted regex is never re-processed). `**` matches across slashes; a
 * single `*` stays within one path segment. Regex metacharacters are escaped.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function normalizeGlobPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Match a filesystem path against a specifier. Both are normalized: `~` expands
 * to the home dir and the target is resolved (collapsing `..`) so it can't
 * escape an allowed subtree. A relative target is resolved against `cwd`, the
 * same base the file tools use (resolveToolCwd), so the path the guard checks
 * is the path that will actually be written. A specifier with no glob is treated
 * as a directory prefix — `/proj` matches `/proj` and everything under it.
 */
export function matchPath(specifier: string, targetPath: string, cwd?: string): boolean {
  const spec = expandHome(specifier.trim());
  const expandedTarget = expandHome(targetPath.trim());
  const target = path.isAbsolute(expandedTarget)
    ? path.resolve(expandedTarget)
    : path.resolve(cwd ?? process.cwd(), expandedTarget);
  if (spec === '*' || spec === '**') return true;
  if (spec.includes('*')) {
    const specAbs = normalizeGlobPath(path.resolve(spec));
    const normalizedTarget = normalizeGlobPath(target);
    if (globToRegExp(specAbs).test(normalizedTarget)) return true;
    // A trailing `/**` also covers the directory itself, not just its contents.
    if (specAbs.endsWith('/**') && normalizedTarget === specAbs.slice(0, -3)) return true;
    return false;
  }
  const dir = path.resolve(spec);
  const relative = path.relative(dir, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

const DDL = new Set(['create', 'alter', 'drop', 'truncate']);
const DML = new Set(['insert', 'update', 'delete']);

/** Strip leading whitespace, SQL comments, and bare `(` so the keyword is exposed. */
function stripLeadingNoise(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = (nl === -1 ? '' : s.slice(nl + 1)).trimStart();
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = (end === -1 ? '' : s.slice(end + 2)).trimStart();
      continue;
    }
    if (s.startsWith('(')) {
      s = s.slice(1).trimStart();
      continue;
    }
    break;
  }
  return s;
}

/**
 * Split SQL into top-level statements in one left-to-right scan aware of
 * string literals (`'…'`), quoted identifiers (`"…"`), dollar-quoted bodies
 * (`$tag$…$tag$`) and line/block comments (block comments nest, per Postgres);
 * only a top-level `;` splits. Stripping comments naively first would let a
 * comment token inside a literal swallow the real `;` and hide a trailing write
 * (`select '-- x'; drop table x`). Comments outside literals become a space.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let buf = '';
  let i = 0;
  const flush = (): void => {
    const t = buf.trim();
    if (t.length > 0) out.push(t);
    buf = '';
  };
  while (i < n) {
    const c = sql.charAt(i);
    const next = sql[i + 1];

    // line comment -- … (to end of line)
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl;
      buf += ' ';
      continue;
    }
    // block comment /* … */ (nestable)
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      buf += ' ';
      continue;
    }
    // single-quoted string ('' escapes a quote)
    if (c === "'" || c === '"') {
      const quote = c;
      buf += c;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          buf += quote + quote;
          i += 2;
          continue;
        }
        buf += sql[i];
        i++;
        if (sql[i - 1] === quote) break;
      }
      continue;
    }
    // dollar-quoted body $tag$ … $tag$ (tag optional). `$1` placeholders don't match.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    // top-level statement separator
    if (c === ';') {
      flush();
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Classify a single statement by its keyword, unwrapping EXPLAIN and CTEs. */
function classifyStatement(stmt: string): string {
  let s = stripLeadingNoise(stmt);
  // EXPLAIN [ ( options ) ] [ ANALYZE ] [ VERBOSE ] <statement> — the inner
  // statement actually runs under ANALYZE, so classify by it.
  const ex = s.match(/^explain\b\s*(?:\([^)]*\)\s*)?(?:(?:analyze|verbose)\s+)*/i);
  if (ex && ex[0].length > 0) s = stripLeadingNoise(s.slice(ex[0].length));
  const first = (s.match(/^[a-zA-Z]+/)?.[0] ?? '').toLowerCase();
  if (first === 'with') {
    // A CTE ultimately performs the first write keyword it contains, else read.
    const lower = s.toLowerCase();
    if (/\binsert\b/.test(lower)) return 'insert';
    if (/\bupdate\b/.test(lower)) return 'update';
    if (/\bdelete\b/.test(lower)) return 'delete';
    return 'select';
  }
  return first;
}

/** Classify a SQL string by its first statement (used for messaging). */
export function classifySql(sql: string): string {
  const [first] = splitStatements(sql);
  return first === undefined ? '' : classifyStatement(first);
}

/**
 * Match a SQL string against a specifier (`select`, `ddl`, `dml`, `*`, …).
 * Multi-statement aware: an allow check requires every statement to satisfy the
 * specifier (so `select 1; drop table x` does not match `select:*`), while a deny
 * check matches if any statement does.
 */
export function matchSql(specifier: string, sql: string, allowContext = false): boolean {
  const spec = specifier.trim().toLowerCase().replace(/:\*$/, '');
  if (spec === '*') return true;
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return false;
  const pred = (kind: string): boolean =>
    spec === 'ddl' ? DDL.has(kind) : spec === 'dml' ? DML.has(kind) : spec === kind;
  return allowContext
    ? stmts.every((s) => pred(classifyStatement(s)))
    : stmts.some((s) => pred(classifyStatement(s)));
}

function matchSpecifier(
  kind: GuardKind,
  specifier: string,
  arg: string,
  allowContext: boolean,
  cwd?: string
): boolean {
  switch (kind) {
    case 'command':
      return matchCommand(specifier, arg, allowContext);
    case 'path':
      return matchPath(specifier, arg, cwd);
    case 'sql':
      return matchSql(specifier, arg, allowContext);
  }
}

export interface PermissionVerdict {
  decision: PermissionDecision;
  /** The list entry that drove a deny/allow decision, for user-facing messaging. */
  rule?: string;
  /** Human-readable explanation (used in tool_result errors / logs). */
  reason?: string;
  /**
   * shell(op:write) only: the full command line(s) the write would submit
   * (pending + chars, joined), so an approval prompt shows `rm -rf x`, not `m -rf x`.
   */
  submittedLines?: string[];
}

export interface ToolPermissionOptions {
  cwd?: string;
  activeToolIds?: ReadonlySet<string>;
  /**
   * The tool's own definition names (`ToolRow.aliases`, e.g. shell's `bash`).
   * A deny entry naming one that is not an old id denies this tool; an allow
   * entry naming one never grants it (isPlainNameAlias).
   */
  toolAliases?: readonly string[] | null;
  /**
   * The tool's display name (`ToolRow.name`, e.g. `Shell`). An allow entry
   * naming it exactly, or a deny entry naming it (or the id) in any case,
   * names this tool, as tool visibility reads it (ruleNamesTool).
   */
  toolName?: string | null;
}

/**
 * Rewrite entries that name the tool by another name to its canonical id, the
 * way every access path reads them: the display name (exactly on the allow
 * side, any case on the deny side; ruleNamesTool) and, on the deny side only,
 * a plain definition name (`bash` for shell). A name the definition carries
 * for discovery must never widen access, so it never rewrites an allow.
 */
function canonicalizeToolNames(
  access: ToolAccessConfig,
  canonicalToolId: string,
  options?: ToolPermissionOptions
): ToolAccessConfig {
  const aliases = options?.toolAliases;
  const tool = { id: canonicalToolId, name: options?.toolName };
  const ruleOptions = { activeToolIds: options?.activeToolIds };
  const rewrite =
    (side: 'allow' | 'deny') =>
    (entry: string): string => {
      const rule = parseRule(entry);
      if (rule.toolId === canonicalToolId) return entry;
      const named =
        ruleNamesTool(rule.toolId, tool, side, ruleOptions) ||
        (side === 'deny' && isPlainNameAlias(rule.toolId, aliases, ruleOptions));
      return named ? formatRule({ ...rule, toolId: canonicalToolId }) : entry;
    };
  return {
    ...access,
    allowList: access.allowList.map(rewrite('allow')),
    denyList: access.denyList.map(rewrite('deny')),
  };
}

/**
 * Decide whether a single (agent, tool, input) call is allowed, denied, or
 * needs confirmation. Pure — the caller maps 'ask' onto a prompt (interactive)
 * or a hard deny (headless).
 */
export function evaluateToolPermission(
  baseAccess: ToolAccessConfig,
  toolId: string,
  input: Record<string, unknown>,
  options?: ToolPermissionOptions
): PermissionVerdict {
  if (baseAccess.mode === 'all') return { decision: 'allow' };
  const resolveForActiveCatalog = (id: string) =>
    options?.activeToolIds?.has(id) ? { id } : resolveToolId(id);
  const toolResolution = resolveForActiveCatalog(toolId);
  const canonicalToolId = toolResolution.id;
  // Search and the clock are safe platform primitives: no allow or deny rule
  // gates them (AgentToolResolver and chat dispatch agree).
  if (isAlwaysAvailableTool(canonicalToolId)) return { decision: 'allow' };
  const access = canonicalizeToolNames(baseAccess, canonicalToolId, options);
  // Alias-scoped rules (old ids that pin an op or another routing param) and
  // bare denies run first and apply to every tool, guarded or not: narrow
  // allow (every pin must match), broad deny (whole tool, or the pinned op).
  const transformedInput = transformToolAliasParams(toolResolution, input);
  const callOp = readToolOp(transformedInput);
  const opVerdict = evaluateOpAccess(access, canonicalToolId, callOp, {
    activeToolIds: options?.activeToolIds,
    callParams: transformedInput,
  });
  if (opVerdict.decision !== 'allow') return opVerdict;
  if (callOp !== null && UNGUARDED_OPS[canonicalToolId]?.has(callOp)) return { decision: 'allow' };
  const kind = guardKindFor(canonicalToolId);
  const extract = EXTRACTORS[canonicalToolId];
  if (!kind || !extract) return { decision: 'allow' };

  const args = extract(transformedInput);
  // shell(op:write) with nothing to submit (a poll / output read) carries no
  // command, so there is nothing to authorize.
  if (canonicalToolId === 'shell' && callOp === 'write' && args.length === 0) {
    return { decision: 'allow' };
  }
  const targets = args.length > 0 ? args : [''];

  const ruleTargetsTool = (rule: ParsedRule, forDeny = false): boolean => {
    const ruleToolId = resolveForActiveCatalog(rule.toolId).id;
    if (ruleToolId === canonicalToolId) {
      const scoped = scopeRule(formatRule(rule), { activeToolIds: options?.activeToolIds });
      // An old id only allows the calls it could make itself: a bare
      // `write_stdin` is no bare allow for shell(op:run), and a bare
      // `git_status` is no bare allow for `git push`.
      if (!forDeny) return allowRuleCoversCall(scoped, callOp, transformedInput);
      // A deny speaks for its op (or the whole tool); other pins never narrow it.
      if (
        scoped.ops
          ? callOp !== null && scoped.ops.includes(callOp)
          : scoped.op === null || scoped.op === callOp
      )
        return true;
      // A command deny (`shell_exec(rm:*)`, `exec_command(rm:*)`) is about the
      // command, not the op that carries it: it also blocks that command typed
      // into a session with op:write. Deny-only, so this can only narrow.
      return rule.specifier !== null && canonicalToolId === 'shell';
    }

    // The bounded git capability and shell surfaces share the same command
    // specifier namespace. A scoped shell_exec(git:*) rule therefore cannot be
    // bypassed with git({subcommand: ...}), and a scoped git rule cannot be
    // bypassed by spelling the same command through a shell tool. Bare rules
    // stay tool-specific: a bare `git` rule must not match every shell command,
    // and a bare `shell_exec` rule must not silently widen to the git tool.
    if (rule.specifier === null) return false;
    if (canonicalToolId === 'git') {
      return SHELL_TOOL_IDS.has(ruleToolId);
    }
    if (SHELL_TOOL_IDS.has(canonicalToolId)) {
      return ruleToolId === 'git';
    }
    return false;
  };

  const denyRules = access.denyList.map(parseRule).filter((r) => ruleTargetsTool(r, true));
  const allowRules = access.allowList.map(parseRule).filter((r) => ruleTargetsTool(r));

  const ruleMatches = (rule: ParsedRule, target: string, allowContext: boolean): boolean => {
    // A bare rule (no specifier) matches every invocation of the tool.
    if (rule.specifier === null) return true;
    return matchSpecifier(kind, rule.specifier, target, allowContext, options?.cwd);
  };

  // Deny wins, evaluated across every target.
  for (const target of targets) {
    const hit = denyRules.find((r) => ruleMatches(r, target, false));
    if (hit) {
      return {
        decision: 'deny',
        rule: formatRule(hit),
        reason: `Blocked by tool-access policy: ${describe(kind, target)} matches deny rule ${formatRule(hit)}.`,
      };
    }
  }

  // Allow only when every target is explicitly permitted.
  const allTargetsAllowed = targets.every((target) =>
    allowRules.some((r) => ruleMatches(r, target, true))
  );
  if (allTargetsAllowed && allowRules.length > 0) {
    return { decision: 'allow' };
  }

  // No matching rule. allow_list is restrictive (ask); deny_list is a
  // blocklist (allow-unless-denied).
  if (access.mode === 'deny_list') return { decision: 'allow' };

  const firstTarget = targets.find((t) => !allowRules.some((r) => ruleMatches(r, t, true)));
  return {
    decision: 'ask',
    reason: `Not covered by an allow rule: ${describe(kind, firstTarget ?? targets[0] ?? '')}.`,
    ...(canonicalToolId === 'shell' && callOp === 'write' ? { submittedLines: args } : {}),
  };
}

function describe(kind: GuardKind, target: string): string {
  switch (kind) {
    case 'command':
      return `command \`${target}\``;
    case 'path':
      return `path \`${target}\``;
    case 'sql':
      return `${classifySql(target)} statement`;
  }
}
