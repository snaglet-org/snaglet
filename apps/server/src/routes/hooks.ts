/**
 * Hooks workspace API — folder-write REST surface for the GUI hook builder,
 * pattern-matched to
 * apps/server/src/domains/tools/routes/workspaces.routes.ts.
 *
 * GET    /api/hooks                          — list all hook workspaces
 * GET    /api/hooks/:hookName                — get one hook's workspace info
 * PUT    /api/hooks/:hookName/run-as         — set or clear the agent the hook runs as (panel only)
 * GET    /api/hooks/:hookName/files/:file    — read a file from a workspace
 * POST   /api/hooks                          — create a new hook workspace
 * PUT    /api/hooks/:hookName/files          — update files in a workspace (panel only)
 * DELETE /api/hooks/:hookName/runs           — clear durable run history
 * DELETE /api/hooks/:hookName                — move files to the Trash + delete durable ownership state
 * PUT    /api/hooks/:hookName/unattended-policy — what a run the hook wakes does with a call that would ask
 * POST   /api/hooks/signal                   — emit a custom hook signal (child-dispatch only)
 *
 * Hooks have no install/deploy state. `HookRegistryService`'s FolderScanner
 * remains the authority that builds/describes/registers them. The explicit
 * run route executes only saved hook code and resolves supplied ids into real
 * lifecycle payloads; it is not an arbitrary unsaved-code surface. A file
 * write becomes live only once the watcher's next pass reaches it — never
 * synchronously with the response.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware, toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';
import { hookCommandAuthMiddleware } from '@server/middleware/hookCliAuth';
import { sendOk, sendCreated } from '@server/utils/http';
import {
  ErrorCode,
  HTTP_STATUS,
  UNATTENDED_POLICIES,
  isUnattendedPolicy,
} from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { hookWorkspaceService } from '@server/services/customHooks/HookWorkspaceService';
import { getHookRegistry } from '@server/services/customHooks/HookRegistryService';
import { resolveDynamicContent } from '@server/services/customHooks/resolveDynamicContent';
import { hookRunLedger } from '@server/services/customHooks/HookRunLedger';
import { type HookInvocationInput } from '@server/services/customHooks/resolveHookInvocation';
import { runHookOnDemand } from '@server/services/customHooks/runHookOnDemand';
import { clearHookRunHistory, deleteHook } from '@server/services/customHooks/HookLifecycleService';
import { hooks } from '@server/services/HookService';
import { SIGNAL_NAME_PATTERN } from '@server/services/hooks/events';
import { runAtChainDepth, runCappedUnattended } from '@server/realtime/runContext';
import { emitHookEnabledChanged } from '@server/realtime/surfaces/hookRuns';

/** Max serialized size of a signal's data. */
const SIGNAL_DATA_MAX_CHARS = 16_000;

const router = Router();

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

// Execution ledger. Keep the static route above every `/:hookName` route so
// "runs" can never be mistaken for a hook workspace id.
router.get(
  '/runs/recent',
  asyncHandler(async (req, res) => {
    sendOk(res, await hookRunLedger.listRecent(parseLimit(req.query.limit, 25)));
  })
);

router.get(
  '/:hookName/runs',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await hookRunLedger.listByHook(req.params.hookName, parseLimit(req.query.limit, 100))
    );
  })
);

router.delete(
  '/:hookName/runs',
  asyncHandler(async (req, res) => {
    sendOk(res, await clearHookRunHistory(req.params.hookName));
  })
);

// Durable operational registry. Source files define behavior; these records
// alone decide whether automatic event/schedule execution is allowed. Each row
// also says what the saved code declares (`declared`: events and schedules,
// from the in-memory registration; null while the hook is not registered, e.g.
// not built yet or its build failed). Nothing is built or registered here.
router.get(
  '/registry',
  asyncHandler(async (_req, res) => {
    const registry = getHookRegistry();
    const rows = await registry.listRegistrations();
    sendOk(
      res,
      rows.map((row) => {
        const meta = registry.getDeclaredMeta(row.name);
        return {
          ...row,
          declared: meta ? { events: meta.events, schedules: meta.schedules } : null,
        };
      })
    );
  })
);

router.get(
  '/:hookName/status',
  asyncHandler(async (req, res) => {
    const row = (await getHookRegistry().listRegistrations()).find(
      (candidate) => candidate.name === req.params.hookName
    );
    if (!row)
      throw new AppError('Hook is not registered', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, row);
  })
);

for (const [route, enabled] of [
  ['enable', true],
  ['disable', false],
] as const) {
  router.post(
    `/:hookName/${route}`,
    hookCommandAuthMiddleware,
    asyncHandler(async (req, res) => {
      const { hookName } = req.params;
      const registry = getHookRegistry();
      const before = (await registry.listRegistrations()).find(
        (candidate) => candidate.name === hookName
      );
      const row = await registry.setEnabled(hookName, enabled);
      if (!row)
        throw new AppError('Hook is not registered', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      // Every window's Hooks list and open builder follow the flip; a repeat
      // of the current state changes nothing, so it tells no one.
      if (before?.enabled !== row.enabled) emitHookEnabledChanged(row.name, row.enabled);
      sendOk(res, row);
    })
  );
}

// PUT /api/hooks/:hookName/unattended-policy {policy} — what a run this hook
// wakes does with a tool call that would ask a person (see UnattendedPolicy).
// The panel token only: neither a hook's own child credential nor the hook
// CLI token may change it, so a hook can never loosen its own runs.
router.put(
  '/:hookName/unattended-policy',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    const policy = (req.body as { policy?: unknown } | undefined)?.policy;
    if (!isUnattendedPolicy(policy)) {
      throw new AppError(
        `policy must be one of: ${UNATTENDED_POLICIES.join(', ')}.`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const row = await getHookRegistry().setUnattendedPolicy(req.params.hookName, policy);
    if (!row)
      throw new AppError('Hook is not registered', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, row);
  })
);

// POST /api/hooks/:hookName/check — build/register the saved hook and report
// the durable registration row plus what the saved code declares (`declared`:
// triggers/schedules from describe, null when the hook failed to register —
// e.g. a build failure, whose detail is on `registration.lastError`). The
// builder's test console keys its event-picker defaults and its
// "Trigger now" schedule affordance on `declared`.
router.post(
  '/:hookName/check',
  hookCommandAuthMiddleware,
  asyncHandler(async (req, res) => {
    if (!hookWorkspaceService.exists(req.params.hookName)) {
      throw new AppError('Hook workspace not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const registry = getHookRegistry();
    await registry.registerHookFolder(req.params.hookName);
    const registration =
      (await registry.listRegistrations()).find(
        (candidate) => candidate.name === req.params.hookName
      ) ?? null;
    sendOk(res, { registration, declared: registry.getDeclaredMeta(req.params.hookName) });
  })
);

// PUT /api/hooks/:hookName/run-as {agentId} — the agent the hook runs as: its
// tool access judges the hook's calls and its name goes on what the hook posts
// and writes. `agentId: null` (or "") clears it back to the default (the
// event's agent, else the ghost system actor). The panel token only: neither a
// hook's own child credential nor the hook CLI token may change it, so hook
// code can never pick its own identity. 400 names a missing, archived, helper
// or ghost agent; 404 an unregistered hook.
router.put(
  '/:hookName/run-as',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (agentId !== null && typeof agentId !== 'string') {
      throw new AppError(
        'agentId must be an agent id, or null to clear it',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const row = await getHookRegistry().setRunAs(req.params.hookName, agentId);
    if (!row)
      throw new AppError('Hook is not registered', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    sendOk(res, row);
  })
);

// POST /api/hooks/content/resolve — live node parameter resolution for saved
// hooks/tools. Child-dispatch auth is accepted; the endpoint is read-only and
// exposes only the five explicitly supported content kinds.
router.post(
  '/content/resolve',
  toolDispatchAuthMiddleware,
  asyncHandler(async (req, res) => {
    const nodeId = typeof req.body?.nodeId === 'string' ? req.body.nodeId : '';
    sendOk(res, await resolveDynamicContent(nodeId));
  })
);

// POST /api/hooks/signal — custom hook signal from hook/tool code
// (`snaglet.emit`). Child-dispatch only: a signal is always something automated
// code emits, so it carries that code's signed chain depth and hook name.
router.post(
  '/signal',
  toolDispatchAuthMiddleware,
  asyncHandler(async (req, res) => {
    if (req.toolExecuteAuthScope !== 'child-dispatch') {
      throw new AppError(
        'Signals are emitted from hook or tool code (snaglet.emit)',
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    }
    const body = (req.body ?? {}) as { name?: unknown; data?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!SIGNAL_NAME_PATTERN.test(name)) {
      throw new AppError(
        'Signal name must be 1-64 chars: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const data = body.data === undefined ? null : body.data;
    if (JSON.stringify(data).length > SIGNAL_DATA_MAX_CHARS) {
      throw new AppError(
        `Signal data must be at most ${SIGNAL_DATA_MAX_CHARS} characters of JSON`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const chainDepth = req.childDispatchChainDepth ?? 0;
    // Emitted in the emitter's signed chain, so a hook on its own signal is
    // stopped by the chain guard (a signal carries no origin).
    const emitSignal = () =>
      hooks.emit('hook:signal', {
        name,
        data,
        hookName: req.hookOriginName ?? null,
        agentId: req.childDispatchAgentId || null,
        chainDepth,
      });
    runAtChainDepth(
      chainDepth,
      // A capped emitter's signal starts capped runs (see unattendedWake.ts).
      () => (req.childDispatchUnattendedCap ? runCappedUnattended(emitSignal) : emitSignal()),
      undefined,
      req.childDispatchChain ?? []
    );
    sendOk(res, { emitted: name, chainDepth });
  })
);

// POST /api/hooks/:hookName/run — code/API-first saved-hook execution. Node
// ids are resolved into the same payloads their real lifecycle events emit;
// no synthetic "sample" record or unsaved-code execution path exists.
router.post(
  '/:hookName/run',
  hookCommandAuthMiddleware,
  asyncHandler(async (req, res) => {
    if (!hookWorkspaceService.exists(req.params.hookName)) {
      throw new AppError('Hook workspace not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const input = (req.body ?? {}) as HookInvocationInput;
    if (input.event && (typeof input.event !== 'object' || Array.isArray(input.event))) {
      throw new AppError(
        'event must be an object',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const fromChild = req.toolExecuteAuthScope === 'child-dispatch';
    const result = await runHookOnDemand(req.params.hookName, input, {
      // The Hook Builder is an explicit test surface and allows
      // testing disabled hooks. The agent-facing hook(op:run) tool requires its
      // own explicit force:true override instead.
      allowDisabled: true,
      contextAgentId: fromChild ? req.childDispatchAgentId : undefined,
      // snaglet.hooks.run from a hook child chains at its signed depth
      // and in its signed chain. A run the chain limits refuse comes back as
      // a run with ok: false and the reason in stderr.
      chainDepth: fromChild ? (req.childDispatchChainDepth ?? 0) : 0,
      hookChain: fromChild ? (req.childDispatchChain ?? []) : [],
    });
    sendOk(res, { runs: result.runs });
  })
);

// GET /api/hooks — list all hook workspaces
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const hooks = hookWorkspaceService.listAll();
    sendOk(res, hooks);
  })
);

// GET /api/hooks/:hookName — get workspace info
router.get(
  '/:hookName',
  asyncHandler(async (req, res) => {
    if (!hookWorkspaceService.exists(req.params.hookName)) {
      throw new AppError('Hook workspace not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const info = hookWorkspaceService.getInfo(req.params.hookName);
    sendOk(res, info);
  })
);

// GET /api/hooks/:hookName/files/:fileName — read a file from a workspace
router.get(
  '/:hookName/files/:fileName',
  asyncHandler(async (req, res) => {
    const content = hookWorkspaceService.readFile(req.params.hookName, req.params.fileName);
    sendOk(res, { content });
  })
);

// POST /api/hooks — create a new hook workspace. A name collision is a 409,
// never a silent overwrite: create-through-the-API must not clobber an
// existing hook.ts (PUT /:hookName/files is the intentional overwrite path).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { hookName, files } = req.body as {
      hookName?: string;
      files?: { 'hook.ts': string };
    };
    if (!hookName || !files || typeof files['hook.ts'] !== 'string') {
      throw new AppError(
        'hookName and files["hook.ts"] are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (hookWorkspaceService.exists(hookName) || hookWorkspaceService.hasPendingDelete(hookName)) {
      throw new AppError(
        `A hook named "${hookName}" already exists or has pending deletion cleanup`,
        ErrorCode.CONFLICT,
        HTTP_STATUS.CONFLICT
      );
    }
    const info = await hookWorkspaceService.create(hookName, files);
    sendCreated(res, { workspace: info });
  })
);

// PUT /api/hooks/:hookName/files — update files in an existing workspace.
// The panel token only: new code puts a person's decisions about the hook
// back to their defaults (run as cleared, unattended policy back to skip),
// and hook code or a script without the panel token must not swap the code
// under them. Agents change hook code through `hook` op `update`.
router.put(
  '/:hookName/files',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    const files = req.body as Partial<{ 'hook.ts': string }>;
    const info = await hookWorkspaceService.updateFiles(req.params.hookName, files);
    sendOk(res, { workspace: info });
  })
);

// DELETE /api/hooks/:hookName — every deletion surface lands here. The
// hook's physical files (source folder + generated build output) are moved
// to the OS Trash (with an `<SNAGLET_HOME>/trash` fallback), then run history,
// owned schedules, and the registration row are removed. Recoverable via
// Finder "Put Back" — the folder scanner re-registers a restored folder.
router.delete(
  '/:hookName',
  asyncHandler(async (req, res) => {
    sendOk(res, await deleteHook(req.params.hookName));
  })
);

export default router;
