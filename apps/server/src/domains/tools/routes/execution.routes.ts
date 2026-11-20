import { Router } from 'express';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  AppError,
  elapsedMs,
  resolveToolId,
  toSnakeCase,
  transformToolAliasParams,
} from '@snaglet/shared/utils';
import { Tools } from '@snaglet/db/tables/tools';
import { Agents } from '@snaglet/db/tables/agents';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { evaluateAgentHeadlessToolCall } from '@server/services/ToolService/lib/agentToolPolicy';
import { getToolExecutionMetadata } from '@server/services/ToolService/lib/executionMetadata';
import { resolveLoginShellPath } from '@server/services/ToolService/lib/loginShellPath';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { nodeExecutable } from '@server/utils/processes';
import { serverConfig } from '@server/config';
import { logger } from '@server/config/logger';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { runAtChainDepth, runCappedUnattended } from '@server/realtime/runContext';
import { runWithActor } from '@server/realtime/actorContext';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { SDK_RUNTIME_SOURCE } from '@server/services/ToolService/customTools/vendorSdk';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import {
  hookCallAsksFirst,
  hookSkippedCallResult,
} from '@server/services/customHooks/hookCallConfirmation';

const router = Router();

// POST /api/tools/execute: execute an internal tool by name.
// Trust boundary: reachable from user-driven surfaces (the panel's ToolView,
// local `snaglet run` SDK scripts), gated at the mount site in tools.routes.ts by
// panelAuthMiddleware or toolDispatchAuthMiddleware. Agents' own tool calls go
// through the socket dispatch loop, never this route, so `act_as_agent_id` is a
// user convenience, not an agent impersonation vector. Server-spawned
// workspace-tool/hook children (and the /execute/test runner) arrive only with
// the narrow child-dispatch credential: no act_as_agent_id, and the acting
// agent is the one bound into the token at mint time (req.childDispatchAgentId),
// never the body's `agent_id`, so a child cannot act as another agent.
router.post(
  '/execute',
  asyncHandler(async (req, res) => {
    const { name, tool_id, input, agent_id, act_as_agent_id } = req.body as {
      name?: string;
      tool_id?: string;
      input?: Record<string, unknown>;
      /** Optional agent id, threaded into the tool handler's context so
       *  per-agent MCP servers route to the right subprocess. Defaults to
       *  undefined (the agent-less bucket). */
      agent_id?: string;
      /**
       * Panel-only "act as" agent id. `agent_id` means the caller is that
       * agent (its tool-access policy applies); `act_as_agent_id` means a
       * person borrows that agent's context (memory scoping, per-agent MCP
       * routing) while staying the principal, so the agent's tool-access
       * policy is deliberately not applied.
       */
      act_as_agent_id?: string;
    };
    const lookup = name ?? tool_id;
    if (!lookup) {
      throw new AppError(
        'name or tool_id is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (agent_id && act_as_agent_id) {
      // Two different principals in one request is always a caller bug.
      throw new AppError(
        'agent_id and act_as_agent_id are mutually exclusive',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Child-dispatch credential invariant (see panelAuth.ts): a spawned
    // workspace-tool/hook child (or the /execute/test runner) may only run a
    // normal tool as the exact agent its credential is bound to: never with
    // panel/act_as authority, never unguarded, never as a different agent.
    // Enforced here, where agent_id/act_as_agent_id are consumed.
    //
    // `effectiveAgentId`, not the raw `agent_id`, feeds every policy check and
    // context below. For child-dispatch it is forced to the token-bound agent
    // (a body agent_id that differs is rejected); for panel/sidecar scope (a
    // person at the panel, or the `snaglet run` CLI) it is the body's agent_id.
    let effectiveAgentId = agent_id;
    if (req.toolExecuteAuthScope === 'child-dispatch') {
      if (act_as_agent_id) {
        throw new AppError(
          'act_as_agent_id requires full panel authority, not the child-dispatch credential',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      const boundAgentId = req.childDispatchAgentId;
      if (!boundAgentId) {
        // This credential is bound to no agent, so it can never satisfy "run
        // as agent X", whatever the body's agent_id claims. Every spawn site
        // binds one: the invoking agent, or the ghost system actor when no
        // agent is behind the run (a person runs the tool, an agentless event
        // fires the hook; ToolExecutor.ts, hookRunner.ts, /execute/test below).
        throw new AppError(
          'agent_id is required when authenticating with the child-dispatch credential',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      if (agent_id && agent_id !== boundAgentId) {
        // The body names a different agent than the one this credential is
        // bound to: an impersonation attempt. Reject outright rather than
        // silently coercing to the bound agent, so the caller sees a clear
        // failure instead of "it ran, but not as who I asked for."
        throw new AppError(
          `agent_id "${agent_id}" does not match the agent this child-dispatch credential was issued for`,
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      effectiveAgentId = boundAgentId;
    }

    const exactTool = await Tools.findById(lookup);
    const aliasResolution = resolveToolId(toSnakeCase(lookup));
    if (!exactTool && aliasResolution.removed) {
      throw new AppError(
        aliasResolution.removed,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const tool =
      exactTool ?? (aliasResolution.aliasedFrom ? await Tools.findById(aliasResolution.id) : null);
    if (!tool) {
      throw new AppError(`Tool "${lookup}" not found`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const permissionInput = exactTool
      ? (input ?? {})
      : transformToolAliasParams(aliasResolution, input ?? {});

    // `action` is the one dispatch-only tool with an executor-level HTTP/SDK
    // implementation. Interactive get_clarification and any future
    // dispatch-only tools remain live-conversation-only.
    const meta = await getToolExecutionMetadata(tool.id);
    if (meta.dispatchOnly && tool.id !== 'action') {
      throw new AppError(
        `Tool "${tool.id}" only runs inside a live agent conversation (socket dispatch loop) and cannot be executed directly`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // act_as must name a real agent. Failing with 400, not 404, is
    // deliberate: ToolView keys its "execution disabled in this build" state
    // on HTTP 404 from this exact endpoint (the route-unmounted signal).
    if (act_as_agent_id) {
      const actAsAgent = await Agents.findById(act_as_agent_id);
      if (!actAsAgent) {
        throw new AppError(
          `Unknown act_as_agent_id "${act_as_agent_id}"`,
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

    // When an agent drives this call (a `snaglet run` SDK script, or a hook/tool
    // child), apply the gate chat runs apply, so a constrained agent can't
    // escape it by shelling out: tool visibility (a subagent helper is judged
    // by its orchestrator's access) and the per-call engine (deny rules,
    // command/path/SQL specifiers, old-id pins). No one can be prompted here,
    // so anything chat would escalate is a hard deny. An agent id with no agent
    // row has no policy and gets the same 403 (not 404, which ToolView reads as
    // "route unmounted"). Not gated: human/CLI calls and act_as (the person
    // stays the principal); `action` is a router whose target the executor
    // gateway checks (ToolExecutor.ts).
    if (effectiveAgentId) {
      const verdict = await evaluateAgentHeadlessToolCall(effectiveAgentId, tool, permissionInput, {
        activeToolIds: new Set(toolRegistry.getToolIds()),
      });
      if (verdict.decision !== 'allow') {
        logger.warn(
          `[tool:policy] blocked /execute for agent ${effectiveAgentId}: ${tool.id} (${verdict.decision})`
        );
        throw new AppError(
          `Blocked by tool-access policy: ${verdict.reason ?? tool.id}`,
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
    }

    // Handler context: act_as and effectiveAgentId both thread an agentId
    // through; with neither, context stays undefined (the agent-less bucket:
    // the actor middleware still attributes the request to the user, but
    // handlers see no agent). Self-only guards that compare against
    // ctx.agentId then cannot fire, e.g. update_identity edits any agent named
    // by input.agent_id: a deliberate user-mode admin capability, attributed to
    // the user (see handlers/agents/updateIdentity.ts).
    const contextAgentId = act_as_agent_id ?? effectiveAgentId;

    // Build a minimal ResolvedAgentTool so the executor can run it.
    // requiresConfirmation is false: the socket loop's confirmation has no
    // HTTP equivalent, so the panel enforces a client-side confirm for tools
    // flagged `destructive` (ToolView).
    const agentTool = {
      agentId: contextAgentId ?? '',
      tool,
      settings: {} as Record<string, unknown>,
      requiresConfirmation: false,
    };

    // A call from a hook or tool child runs at the chain depth and in
    // the hook chain signed into its dispatch token; every other caller is a
    // person's action (depth 0, no chain).
    const fromChild = req.toolExecuteAuthScope === 'child-dispatch';
    const chainDepth = fromChild ? (req.childDispatchChainDepth ?? 0) : 0;
    const hookChain = fromChild ? (req.childDispatchChain ?? []) : [];
    const hookOrigin = req.hookOriginName
      ? { kind: 'hook' as const, hookName: req.hookOriginName }
      : undefined;
    // Nobody can answer a hook's own call that would ask first (the tool or
    // op is set to ask, though the access rules allow it): it is skipped with
    // a tool error, as an unattended run's `skip` policy does, and the hook
    // carries on. `action` is a router; the executor gateway checks its target.
    if (
      fromChild &&
      hookOrigin &&
      effectiveAgentId &&
      tool.id !== 'action' &&
      (await hookCallAsksFirst(effectiveAgentId, tool, permissionInput, req.childDispatchThreadId))
    ) {
      logger.warn(
        `[hooks] "${hookOrigin.hookName}" skipped ${tool.id} for ${effectiveAgentId}: it asks first`
      );
      sendOk(res, hookSkippedCallResult(tool.id, permissionInput));
      return;
    }
    // Run as is the opt-in for agent attribution: a hook set to run as an
    // agent (signed into its token) writes as that agent, so table history
    // and realtime events name it. Every other hook run keeps
    // the request's ambient actor.
    const hookRunAs = fromChild && Boolean(hookOrigin) && req.childDispatchRunAs === true;
    const hookAgent =
      hookRunAs && effectiveAgentId && effectiveAgentId !== GHOST_AGENT_ID
        ? await Agents.findById(effectiveAgentId)
        : null;
    // A hook run an agent started or caused may not auto-approve anything it
    // wakes: the cap signed into its token is bound for the call.
    const capped = fromChild && req.childDispatchUnattendedCap === true;
    const withCap = <T>(fn: () => T): T => (capped ? runCappedUnattended(fn) : fn());
    // The hook is also bound ambiently, for events emitted deep in a write
    // path no handler context reaches (table_entry:occurrence's origin).
    const execute = () =>
      runAtChainDepth(
        chainDepth,
        () =>
          withCap(() =>
            toolExecutor.execute(
              { name: lookup, input: input ?? {} },
              agentTool,
              contextAgentId
                ? {
                    agentId: contextAgentId,
                    bypassToolAccess: Boolean(act_as_agent_id),
                    ...(hookOrigin ? { hookOrigin } : {}),
                    ...(hookRunAs ? { hookRunAs: true } : {}),
                    ...(hookOrigin && req.childDispatchThreadId
                      ? { hookThreadId: req.childDispatchThreadId }
                      : {}),
                    // SDK callers (hook and tool code) also get structured data.
                    ...(fromChild ? { structuredResult: true } : {}),
                  }
                : hookOrigin
                  ? { hookOrigin }
                  : undefined
            )
          ),
        hookOrigin,
        hookChain
      );
    const result = hookAgent
      ? await runWithActor(
          { actorKind: 'agent', actorId: hookAgent.id, actorName: hookAgent.name },
          execute
        )
      : await execute();
    sendOk(res, result);
  })
);

// POST /api/tools/execute/log — log message from a running user tool (fire-and-forget)
router.post(
  '/execute/log',
  asyncHandler(async (req, res) => {
    const { level, message } = req.body as { level?: string; message?: string };
    const tag = `\x1b[35m[user-tool]\x1b[0m`;
    if (level === 'error') {
      logger.error(`${tag} ${message}`);
    } else if (level === 'warn') {
      logger.warn(`${tag} ${message}`);
    } else {
      logger.info(`${tag} ${message}`);
    }
    sendOk(res, null);
  })
);

// POST /api/tools/execute/test — run raw tool code without saving/deploying
router.post(
  '/execute/test',
  asyncHandler(async (req, res) => {
    const { code, input } = req.body as {
      code?: string;
      input?: Record<string, unknown>;
    };
    if (!code) {
      throw new AppError('code is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }

    const t0 = Date.now();
    const testDir = path.join(tmpdir(), `snaglet-tool-test-${Date.now()}`);

    try {
      mkdirSync(testDir, { recursive: true });

      // Write the tool source
      writeFileSync(path.join(testDir, 'tool.ts'), code, 'utf-8');

      // Everything here is ESM, declared rather than left to Node's syntax
      // detection or to whatever package.json sits above the temp dir. The
      // package scope lookup stops at node_modules, so @snaglet/sdk declares its own.
      writeFileSync(
        path.join(testDir, 'package.json'),
        JSON.stringify({ type: 'module' }),
        'utf-8'
      );

      // @snaglet/sdk is the same SDK a deployed tool gets (vendorSdk.ts
      // SDK_RUNTIME_SOURCE), so snaglet.tables.read, parseContent, hooks.run, emit
      // and the rest are there under Test too. It holds no secret: it reads
      // SNAGLET_SERVER_URL, SNAGLET_TOOL_CONTEXT_JSON and SNAGLET_CHILD_DISPATCH_TOKEN from
      // the child's env, set at spawn time below, so the credential never
      // reaches disk.
      const sdkDir = path.join(testDir, 'node_modules', '@snaglet', 'sdk');
      mkdirSync(sdkDir, { recursive: true });
      const serverUrl = serverConfig.apiBaseUrl;
      writeFileSync(
        path.join(sdkDir, 'package.json'),
        JSON.stringify({ name: '@snaglet/sdk', type: 'module', main: 'index.js' }),
        'utf-8'
      );
      writeFileSync(path.join(sdkDir, 'index.js'), SDK_RUNTIME_SOURCE, 'utf-8');

      // Write a runner that imports the tool, reads stdin, calls handler, prints
      // result. ESM has no extension lookup, so the import names the file in full.
      writeFileSync(
        path.join(testDir, 'runner.js'),
        `
import handler from './dist/tool.js';
let data = '';
process.stdin.on('data', c => data += c);
process.stdin.on('end', async () => {
  try {
    const { input, settings } = JSON.parse(data);
    const result = await handler(input ?? {}, settings ?? {});
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (e) {
    process.stderr.write(e?.message ?? String(e));
    process.exit(1);
  }
});
`,
        'utf-8'
      );

      // npx comes from the login shell's PATH: Snaglet.app opened from the Dock
      // inherits launchd's, which has no npx.
      await resolveLoginShellPath();

      // Bundle with esbuild
      const esbuildResult = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          'npx',
          [
            'esbuild',
            'tool.ts',
            '--bundle',
            '--platform=node',
            '--format=esm',
            '--outfile=dist/tool.js',
            '--external:@snaglet/sdk',
          ],
          // npx runs the first `esbuild` on PATH or in a local node_modules/.bin, which an
          // agent can write to, so it never gets the server's own environment.
          { cwd: testDir, stdio: ['pipe', 'pipe', 'pipe'], env: buildCommandEnv() }
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (c: Buffer) => {
          stdout += c;
        });
        child.stderr.on('data', (c: Buffer) => {
          stderr += c;
        });
        child.on('error', reject);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('esbuild timed out'));
        }, 15_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });

      if (esbuildResult.code !== 0) {
        const errText = esbuildResult.stderr.trim() || esbuildResult.stdout.trim();
        sendOk(res, {
          success: false,
          output: '',
          error: `Build failed:\n${errText}`,
          durationMs: elapsedMs(t0),
        });
        return;
      }

      // Run the tool
      const runResult = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolve, reject) => {
        // Allowlist: only safe, non-secret env vars reach the user-authored
        // tool process; never spread process.env (DB credentials, API keys,
        // encryption keys). SNAGLET_CHILD_DISPATCH_TOKEN is a narrow per-spawn
        // token (see panelAuth.ts), never the panel token and never on disk.
        // Unsaved test code has no agent, so the token is bound to the ghost
        // system actor, as a deployed tool a person runs is (ToolExecutor):
        // every SDK call from here (snaglet.tables.read, snaglet.tools.execute, ...)
        // runs as ghost, gated by ghost's allow list (GHOST_TOOL_ACCESS in
        // agentToolPolicy.ts), and a refusal throws with the server's message
        // ("Snaglet server returned 403: ... Blocked by tool-access policy ...").
        // The SDK, credential, executable and PATH match a deployed tool's
        // (the bundle format does not: Test bundles ESM, a saved tool is
        // bundled as CommonJS). No NODE_PATH: ESM resolution ignores it.
        // No --input-type flag: Node refuses it with a file entry point
        // (ERR_INPUT_TYPE_NOT_ALLOWED), so the runner never started.
        const child = spawn(nodeExecutable(), ['runner.js'], {
          cwd: testDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_ENV: process.env.NODE_ENV,
            SNAGLET_SERVER_URL: serverUrl,
            SNAGLET_TOOL_CONTEXT_JSON: '{}',
            SNAGLET_CHILD_DISPATCH_TOKEN: mintChildDispatchToken(GHOST_AGENT_ID),
          },
        });
        let stdout = '',
          stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, 30_000);
        child.stdout.on('data', (c: Buffer) => {
          stdout += c;
        });
        child.stderr.on('data', (c: Buffer) => {
          stderr += c;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        });
        child.stdin.write(JSON.stringify({ input: input ?? {}, settings: {} }));
        child.stdin.end();
      });

      if (runResult.timedOut) {
        sendOk(res, {
          success: false,
          output: '',
          error: 'Tool timed out after 30s',
          durationMs: elapsedMs(t0),
        });
        return;
      }

      if (runResult.code !== 0) {
        sendOk(res, {
          success: false,
          output: '',
          error: runResult.stderr.trim() || runResult.stdout.trim() || 'Tool failed',
          durationMs: elapsedMs(t0),
        });
        return;
      }

      sendOk(res, {
        success: true,
        output: runResult.stdout.trim() || '(no output)',
        durationMs: elapsedMs(t0),
      });
    } finally {
      // Clean up temp directory
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  })
);

export default router;
