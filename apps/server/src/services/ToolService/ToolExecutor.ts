/**
 * ToolExecutor — thin gateway that routes tool calls to domain-specific handlers.
 *
 * Handlers are auto-discovered from ./tools/{name}/tool.ts via the ToolRegistry.
 * This file owns:
 * 1. The action gateway (single-tool routing)
 * 2. External tool execution (HTTP + spawn)
 * 3. The ToolExecutorService class (public API)
 */

import crossSpawn from 'cross-spawn';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ToolHandlerContext } from './types';
import { toolRegistry } from './ToolRegistry';
import { isRecord, asNonEmptyString, asStringArray } from '@snaglet/shared/utils/type-guards';
import {
  elapsedMs,
  getErrorMessage,
  resolveToolId,
  toSnakeCase,
  transformToolAliasParams,
} from '@snaglet/shared/utils';
import { serverConfig } from '@server/config';
import { logger } from '@server/config/logger';
import { formatMcpSuccess } from './lib/mcpResult';
import { buildToolEnv } from './lib/buildSafeEnv';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { currentChainDepth, currentHookChain } from '@server/realtime/runContext';
import { normalizeToolParams } from './lib/normalizeToolParams';
import { unwrapDoubleWrappedInput } from './lib/unwrapDoubleWrappedInput';
import { resolveToolTimeoutMs, withExecutionGuards } from './lib/executionGuards';
import { neutralizeSystemFraming } from './lib/untrustedContent';
import { extractActionParams } from './lib/extractActionParams';
import { findResolvedAgentTool } from './lib/resolveAgentTool';
import { gatewayMissMessage } from './lib/toolMissMessages';
import { killProcessTree, nodeExecutable } from '@server/utils/processes';

const TOOL_LOG_PREFIX = '\x1b[33m[tool]\x1b[0m';
const loggedDeprecationAliases = new Set<string>();

function stringifyHandlerOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ToolCallInput {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallResult {
  success: boolean;
  output: string;
  /**
   * Optional structured tool output (e.g. MCP content blocks). Preserves
   * non-text payloads like images that would otherwise be lost when the
   * result is stringified into `output`.
   */
  rawContent?: unknown;
  error?: string;
  durationMs: number;
}

interface ExternalToolConfig {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}

function getToolConfig(tool: import('@snaglet/db').ToolRow): Record<string, unknown> {
  const row = tool as unknown as {
    configJson?: Record<string, unknown>;
    config_json?: Record<string, unknown>;
  };
  const config = row.configJson ?? row.config_json;
  return isRecord(config) ? config : {};
}

interface SpawnToolOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  payload: string;
  timeoutMs: number;
  label: string;
  /** Run abort (guardrail-3): kills the child so Stop reaches the process. */
  signal?: AbortSignal;
}

async function spawnToolProcess(opts: SpawnToolOptions): Promise<string> {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = crossSpawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, opts.timeoutMs);

    const onAbort = (): void => {
      killProcessTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    child.stdin?.write(opts.payload);
    child.stdin?.end();
  });

  if (result.timedOut) {
    throw new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`);
  }
  if (result.code !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || 'No output';
    const signalSuffix = result.signal ? ` (${result.signal})` : '';
    throw new Error(
      `${opts.label} failed with exit code ${result.code ?? 'unknown'}${signalSuffix}: ${details}`
    );
  }

  return result.stdout.trim() || result.stderr.trim() || '(no output)';
}

function resolveExternalToolConfig(settings: Record<string, unknown>): ExternalToolConfig | null {
  const external = isRecord(settings.external_runner) ? settings.external_runner : {};

  const command = asNonEmptyString(external.command) ?? asNonEmptyString(settings.external_command);
  if (!command) return null;

  const scriptPath =
    asNonEmptyString(external.script_path) ??
    asNonEmptyString(external.scriptPath) ??
    asNonEmptyString(settings.external_script_path);
  const argsFromConfig = asStringArray(external.args);
  const argsFromSettings = asStringArray(settings.external_args);
  const args = [
    ...(scriptPath ? [scriptPath] : []),
    ...(argsFromConfig.length > 0 ? argsFromConfig : argsFromSettings),
  ];

  const cwd =
    asNonEmptyString(external.cwd) ?? asNonEmptyString(settings.external_cwd) ?? undefined;
  const timeoutCandidate = Number(
    external.timeout_ms ??
      external.timeoutMs ??
      settings.external_timeout_ms ??
      settings.timeout_ms ??
      30000
  );
  const timeoutMs =
    Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : 30000;

  return { command, args, cwd, timeoutMs };
}

async function executeExternalTool(
  call: ToolCallInput,
  config: ExternalToolConfig,
  context?: ToolHandlerContext
): Promise<string> {
  return spawnToolProcess({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: buildToolEnv({
      SNAGLET_TOOL_NAME: call.name,
      SNAGLET_TOOL_CONTEXT_JSON: JSON.stringify(context ?? {}),
    }),
    payload: JSON.stringify({
      tool: call.name,
      input: call.input,
      context: context ?? {},
    }),
    timeoutMs: config.timeoutMs,
    label: 'External tool',
    signal: context?.signal,
  });
}

/**
 * Detect whether a tool is a workspace tool by checking config_json.
 */
function isWorkspaceTool(settings: Record<string, unknown>): boolean {
  return settings.workspace_tool === true && typeof settings.built_path === 'string';
}

/**
 * Execute a workspace tool by spawning it as a Node child process.
 * The tool receives input via stdin and the Snaglet server URL + token via env vars
 * so it can call back into the server using @snaglet/sdk.
 */
async function executeWorkspaceTool(
  call: ToolCallInput,
  settings: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<string> {
  const builtPath = settings.built_path as string;
  const workspaceDir = (settings.workspace_dir as string) ?? undefined;
  const timeoutMs = Number(settings.timeout_ms ?? 30_000);

  return spawnToolProcess({
    command: nodeExecutable(),
    args: [builtPath],
    cwd: workspaceDir,
    env: buildToolEnv({
      SNAGLET_SERVER_URL: serverConfig.apiBaseUrl,
      SNAGLET_TOOL_NAME: call.name,
      SNAGLET_TOOL_CONTEXT_JSON: JSON.stringify(context ?? {}),
      // Workspace tools call back into /api/tools/execute via @snaglet/sdk. They
      // run agent/user-authored code, so they get only a narrow per-spawn
      // child-dispatch credential (panelAuth.ts), never the panel token (which
      // also grants act_as and /execute/test). It is bound to the invoking
      // agent, and /execute derives the acting agent from that binding, so
      // the child cannot forge an agent_id and run tools as another agent;
      // that agent's own tool-access policy still applies. A tool a person
      // runs (the panel's Run, `snaglet run` with no agent) has no agent, so its
      // nested calls act as the ghost system actor, gated by ghost's
      // code-defined allow list (GHOST_TOOL_ACCESS in agentToolPolicy.ts),
      // exactly as agentless hooks do (hookRunner.ts actingAgentId): /execute
      // rejects a credential bound to no agent, so an unbound one could never
      // run anything. buildToolEnv's allow-list (buildSafeEnv.ts) also keeps
      // SNAGLET_PANEL_TOKEN out of the env.
      // A tool spawned inside a woken or hook-caused run keeps its
      // chain depth and hook chain (signed), so anything it triggers is
      // stamped correctly and a hook it leads back to is stopped.
      SNAGLET_CHILD_DISPATCH_TOKEN: mintChildDispatchToken(
        context?.agentId || GHOST_AGENT_ID,
        undefined,
        currentChainDepth(),
        currentHookChain()
      ),
    }),
    payload: JSON.stringify({
      tool: call.name,
      input: call.input,
      context: context ?? {},
    }),
    timeoutMs,
    label: 'Workspace tool',
    signal: context?.signal,
  });
}

class ToolExecutorService {
  private async ensureLoaded(): Promise<void> {
    if (!toolRegistry.isLoaded) {
      await toolRegistry.load();
      logger.info(`${TOOL_LOG_PREFIX} Registry loaded: ${toolRegistry.size} tools`);
    }
  }

  async execute(
    call: ToolCallInput,
    agentTool: ResolvedAgentTool,
    context?: ToolHandlerContext
  ): Promise<ToolCallResult> {
    await this.ensureLoaded();

    const t0 = Date.now();

    // Lenient double-wrap unwrap (small-model quirk): a call whose input is
    // the function-call envelope itself — e.g. `{ function_name: "create_doc",
    // arguments: { title: … } }` — is unwrapped to the inner arguments object
    // before any validation, but only when the wrapper names this same tool,
    // the inner value is a plain object, and nothing else meaningful is
    // present (see lib/unwrapDoubleWrappedInput.ts for the exact contract and
    // the collision audit of builtin parameter names).
    {
      const callAlias = resolveToolId(toSnakeCase(call.name));
      const unwrap = unwrapDoubleWrappedInput(call.input, [
        call.name,
        callAlias.removed ? undefined : callAlias.id,
        agentTool.tool.id,
      ]);
      if (unwrap) {
        logger.debug(
          `${TOOL_LOG_PREFIX} unwrapped double-wrapped input for '${call.name}': ` +
            `wrapper { ${unwrap.nameKey}: "${unwrap.wrapperToolName}", ${unwrap.argsKey}: {…} } → inner arguments object`
        );
        call = { name: call.name, input: unwrap.input };
      }
    }

    if (call.name === 'action') {
      const targetLookup =
        asNonEmptyString(call.input.tool) ?? asNonEmptyString(call.input.tool_name);
      if (!targetLookup) {
        return {
          success: false,
          output: '',
          error: 'action requires a non-empty tool or tool_name.',
          durationMs: elapsedMs(t0),
        };
      }
      if (toSnakeCase(targetLookup) === 'action') {
        return {
          success: false,
          output: '',
          error: 'action cannot dispatch itself.',
          durationMs: elapsedMs(t0),
        };
      }

      let target: ResolvedAgentTool | undefined;
      if (context?.agentId) {
        const { resolveAgentTools, resolveAgentToolsForExecution } =
          await import('@server/services/AgentToolResolver');
        const available = context.bypassToolAccess
          ? await resolveAgentToolsForExecution(context.agentId)
          : await resolveAgentTools(context.agentId);
        target = findResolvedAgentTool(available, targetLookup);
      } else {
        const { Tools } = await import('@snaglet/db/tables/tools');
        let exact = await Tools.findById(targetLookup);
        if (!exact) exact = await Tools.findByAlias(targetLookup.toLowerCase());
        if (!exact) {
          const byName = await Tools.query<{ id: string }>(
            `SELECT id FROM tools WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [targetLookup]
          );
          if (byName[0]) exact = await Tools.findById(byName[0].id);
        }
        const resolution = resolveToolId(toSnakeCase(targetLookup));
        const row = exact ?? (resolution.removed ? null : await Tools.findById(resolution.id));
        if (row) {
          target = {
            agentId: '',
            tool: row,
            settings: {},
            requiresConfirmation: false,
          };
        }
      }

      if (!target || target.tool.id === 'action') {
        return {
          success: false,
          output: '',
          error: gatewayMissMessage(targetLookup),
          durationMs: elapsedMs(t0),
        };
      }
      const extractedTargetInput = extractActionParams(call.input);
      const targetAlias = resolveToolId(toSnakeCase(targetLookup));
      const targetInput =
        targetAlias.aliasedFrom && targetAlias.id === target.tool.id
          ? transformToolAliasParams(targetAlias, extractedTargetInput)
          : extractedTargetInput;
      if (context?.agentId && !context.bypassToolAccess) {
        // The same headless gate /api/tools/execute applies (agentToolPolicy):
        // the agent's policy (a subagent helper's is its orchestrator's),
        // visibility, then the per-call engine. Nobody can be asked here, so
        // anything but `allow` is refused, and so is an agent id with no row
        // behind it (deleted since its tools resolved). bypassToolAccess
        // (act_as) skips it on purpose: a person at the panel is the principal.
        const { evaluateAgentHeadlessToolCall } = await import('./lib/agentToolPolicy');
        const verdict = await evaluateAgentHeadlessToolCall(
          context.agentId,
          target.tool,
          targetInput,
          { activeToolIds: new Set(toolRegistry.getToolIds()) }
        );
        if (verdict.decision !== 'allow') {
          return {
            success: false,
            output: '',
            error: `Blocked by tool-access policy: ${verdict.reason ?? target.tool.id}`,
            durationMs: elapsedMs(t0),
          };
        }
      }
      // A hook's call through the gateway asks first as a direct one would:
      // nobody can answer, so it is skipped (hookCallConfirmation.ts).
      if (context?.hookOrigin && context.agentId) {
        const { hookCallAsksFirst, hookSkippedCallResult } =
          await import('@server/services/customHooks/hookCallConfirmation');
        if (
          await hookCallAsksFirst(context.agentId, target.tool, targetInput, context.hookThreadId)
        ) {
          return {
            ...hookSkippedCallResult(target.tool.id, targetInput),
            durationMs: elapsedMs(t0),
          };
        }
      }
      return this.execute({ name: targetLookup, input: targetInput }, target, context);
    }

    // Exact live handlers always win. Only when no definition exists under the
    // called id do we fall through to its permanent alias.
    let executionName = call.name;
    let executionInput = call.input;
    let handler = toolRegistry.getHandler(executionName);
    if (!handler) {
      const resolution = resolveToolId(toSnakeCase(call.name));
      if (resolution.removed) {
        return {
          success: false,
          output: '',
          error: resolution.removed,
          durationMs: elapsedMs(t0),
        };
      }
      const aliasHandler = resolution.aliasedFrom
        ? toolRegistry.getHandler(resolution.id)
        : undefined;
      if (resolution.aliasedFrom && aliasHandler) {
        executionName = resolution.id;
        executionInput = transformToolAliasParams(resolution, call.input);
        handler = aliasHandler;
        if (!loggedDeprecationAliases.has(resolution.aliasedFrom)) {
          loggedDeprecationAliases.add(resolution.aliasedFrom);
          logger.warn(
            `${TOOL_LOG_PREFIX} deprecated id "${resolution.aliasedFrom}" resolved to "${resolution.id}"`
          );
        }
      }
    }
    // Display-name and definition-alias calls may already carry their exact
    // resolved row. This fallback intentionally follows catalog-alias
    // resolution so alias parameter transforms are never skipped.
    const resolvedRowHandler = !handler ? toolRegistry.getHandler(agentTool.tool.id) : undefined;
    if (!handler && resolvedRowHandler) {
      executionName = agentTool.tool.id;
      handler = resolvedRowHandler;
    }

    const agentLabel =
      context?.runtime?.agentName ?? context?.agentId ?? agentTool.agentId ?? 'unknown-agent';
    logger.info(`${TOOL_LOG_PREFIX} ${agentLabel} -> ${executionName}`);

    const settings = {
      ...getToolConfig(agentTool.tool),
      ...agentTool.settings,
    };
    const externalConfig = resolveExternalToolConfig(settings);
    const executionCall = { name: executionName, input: executionInput };

    // Guardrails 2+3: every execution — builtin, workspace, external, MCP — is
    // raced against a hard timeout and the run's AbortSignal. A hung tool call
    // resolves as a structured timeout/abort result the model can react to
    // instead of wedging the run forever; the abandoned work is detached
    // (process-backed tools kill their own children via the shell guards).
    const dispatch = async (): Promise<ToolCallResult> => {
      if (handler) {
        // Alias-normalization chokepoint: fill in whatever internal key the
        // handler expects (doc_id, container_id, thread_id, node_id, …) from
        // the agent-facing name(s) declared in the tool's `param_aliases`
        // (typically the standardized `id`). Handler code is never touched;
        // callers who already send the internal key are unaffected.
        const definition = toolRegistry.getDefinition(executionName);
        const normalizedInput = normalizeToolParams(executionInput, definition?.param_aliases);
        const handlerResult = await handler(normalizedInput, settings, context);
        // If handler returns { output, rawContent }, promote rawContent to top-level
        if (
          handlerResult &&
          typeof handlerResult === 'object' &&
          'rawContent' in (handlerResult as object)
        ) {
          const rich = handlerResult as { output: unknown; rawContent: unknown };
          return {
            success: true,
            output: stringifyHandlerOutput(rich.output),
            rawContent: rich.rawContent,
            durationMs: elapsedMs(t0),
          };
        }
        return {
          success: true,
          output: stringifyHandlerOutput(handlerResult),
          durationMs: elapsedMs(t0),
        };
      }

      // Workspace tools — user-created tools with built JS on disk
      if (isWorkspaceTool(settings)) {
        const output = await executeWorkspaceTool(executionCall, settings, context);
        return { success: true, output, durationMs: elapsedMs(t0) };
      }

      if (externalConfig) {
        const output = await executeExternalTool(executionCall, externalConfig, context);
        return { success: true, output, durationMs: elapsedMs(t0) };
      }

      if (agentTool.tool.type === 'mcp') {
        const { mcpService } = await import('@server/services/McpService');
        // Thread agentId so per-agent servers route to the right
        // subprocess; routing resolves the leading known server id. A
        // helper's tool carries its orchestrator's id (mcpAgentId), so it runs
        // on the orchestrator's connection.
        const result = await mcpService.callTool(executionName, executionInput, {
          agentId: agentTool.mcpAgentId ?? context?.agentId,
        });
        if ('error' in result) {
          // result.error/result.detail come from the MCP server's own
          // response — an attacker-controlled or compromised server can
          // shape either as a forged `<system-reminder>` tag, and this
          // string flows through the same unescaped path as success output
          // once it lands in a tool_result. server is a config-resolved id,
          // not remote-controlled text — left as-is. The outside-content
          // notice is added where the result enters an agent's context.
          const safeError = neutralizeSystemFraming(String(result.error));
          const safeDetail = result.detail ? neutralizeSystemFraming(String(result.detail)) : '';
          return {
            success: false,
            output: '',
            error: `MCP call failed for "${executionName}" — ${safeError}${safeDetail ? `: ${safeDetail}` : ''} (server: ${result.server})`,
            durationMs: elapsedMs(t0),
          };
        }

        return {
          success: true,
          ...formatMcpSuccess(result.content),
          durationMs: elapsedMs(t0),
        };
      }

      return {
        success: false,
        output: '',
        error: `No handler for tool '${executionName}'`,
        durationMs: elapsedMs(t0),
      };
    };

    const timeoutMs = resolveToolTimeoutMs(executionName, executionInput, settings);
    try {
      const outcome = await withExecutionGuards(dispatch(), {
        timeoutMs,
        signal: context?.signal,
      });
      if (outcome.kind === 'timeout') {
        logger.warn(
          `${TOOL_LOG_PREFIX} ${agentLabel} -> ${executionName} TIMED OUT after ${timeoutMs}ms — result abandoned`
        );
        return {
          success: false,
          output: '',
          error:
            `Tool '${executionName}' timed out after ${timeoutMs}ms and was abandoned. ` +
            `Do not immediately retry the identical call — narrow the operation or raise timeout_ms if it is legitimately long.`,
          durationMs: elapsedMs(t0),
        };
      }
      if (outcome.kind === 'aborted') {
        logger.warn(`${TOOL_LOG_PREFIX} ${agentLabel} -> ${executionName} ABORTED (run canceled)`);
        return {
          success: false,
          output: '',
          error: `Tool '${executionName}' was aborted — the run was stopped.`,
          durationMs: elapsedMs(t0),
        };
      }
      return outcome.value;
    } catch (err) {
      // Umbrella catch for every dispatch path (builtin handler throw,
      // workspace/external tool spawn failure, etc.) — the thrown message
      // can embed untrusted data the tool was processing when it failed
      // (e.g. a parse error quoting the offending input), so neutralize it
      // here too, same as the MCP branch above.
      const message = neutralizeSystemFraming(getErrorMessage(err));
      return { success: false, output: '', error: message, durationMs: elapsedMs(t0) };
    }
  }
}

export const toolExecutor = new ToolExecutorService();
