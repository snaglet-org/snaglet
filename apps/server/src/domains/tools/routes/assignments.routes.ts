import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk, sendCreated } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { Tools } from '@snaglet/db/tables/tools';
import { Agents } from '@snaglet/db/tables/agents';
import type { AgentRow, UpdateAgentInput } from '@snaglet/db/tables/agents';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { emitAgentRowChanges } from '@server/realtime/surfaces/agents';
import type { ToolOverride } from '@snaglet/shared/types';
import { AppError, unique } from '@snaglet/shared/utils';
import { canonicalAgentTools } from '@server/services/ToolService/lib/canonicalToolRows';

const router = Router();

// Tool access fields live on flat columns of public.agents:
//   tool_access_mode, tool_access_allow_list, tool_access_deny_list, tool_overrides.
// These routes are thin wrappers that mutate those columns.

async function loadAgent(agentId: string) {
  const agent = await Agents.findById(agentId);
  if (!agent) throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  return agent;
}

/** Write tool-access columns and announce the ones that actually changed. */
async function updateAgentToolAccess(before: AgentRow, patch: UpdateAgentInput): Promise<void> {
  const after = await Agents.update(before.id, patch);
  if (!after) throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  emitAgentRowChanges(
    before.id,
    before,
    after,
    Object.keys(patch) as Array<keyof UpdateAgentInput & keyof AgentRow>
  );
}

// GET /api/tools/agent/:agentId — the agent's tools, canonical ids only (an
// alias id still resolves at call time but is never listed).
router.get(
  '/agent/:agentId',
  asyncHandler(async (req, res) => {
    const tools = await resolveAgentTools(req.params.agentId);
    sendOk(res, canonicalAgentTools(tools));
  })
);

// POST /api/tools/agent/:agentId — set per-tool override; auto-add to allow list if needed.
router.post(
  '/agent/:agentId',
  asyncHandler(async (req, res) => {
    const { toolId, settings, requiresConfirmation } = req.body as {
      toolId?: string;
      settings?: Record<string, unknown>;
      requiresConfirmation?: boolean;
    };
    if (!toolId) {
      throw new AppError('toolId is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const tool = await Tools.findById(toolId);
    if (!tool) throw new AppError('Tool not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const agent = await loadAgent(req.params.agentId);
    const toolOverrides: Record<string, ToolOverride> = {
      ...((agent.toolOverrides ?? {}) as Record<string, ToolOverride>),
    };
    const override: ToolOverride = {};
    if (settings !== undefined) override.settings = settings;
    if (requiresConfirmation !== undefined) override.requiresConfirmation = requiresConfirmation;
    toolOverrides[toolId] = override;

    let toolAccessAllowList = agent.toolAccessAllowList;
    if (agent.toolAccessMode === 'allow_list') {
      const set = new Set(agent.toolAccessAllowList ?? []);
      if (!set.has(toolId)) {
        set.add(toolId);
        toolAccessAllowList = [...set];
      }
    }

    await updateAgentToolAccess(agent, {
      toolOverrides,
      ...(toolAccessAllowList !== agent.toolAccessAllowList ? { toolAccessAllowList } : {}),
    });
    sendCreated(res, { toolId, override });
  })
);

// PUT /api/tools/agent/:agentId — switch to allow_list mode and replace the list.
router.put(
  '/agent/:agentId',
  asyncHandler(async (req, res) => {
    const { toolIds } = req.body as { toolIds?: string[] };
    if (!Array.isArray(toolIds)) {
      throw new AppError(
        'toolIds array is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const agent = await loadAgent(req.params.agentId);
    const toolAccessAllowList = unique(toolIds);
    await updateAgentToolAccess(agent, {
      toolAccessMode: 'allow_list',
      toolAccessAllowList,
    });
    sendOk(res, { toolAccessMode: 'allow_list', toolAllowList: toolAccessAllowList });
  })
);

// PATCH /api/tools/agent/:agentId/:toolId — update an existing per-tool override.
router.patch(
  '/agent/:agentId/:toolId',
  asyncHandler(async (req, res) => {
    const { agentId, toolId } = req.params;
    const { settings, requiresConfirmation } = req.body as {
      settings?: Record<string, unknown>;
      requiresConfirmation?: boolean;
    };

    const agent = await loadAgent(agentId);
    const existing = (agent.toolOverrides ?? {})[toolId] as ToolOverride | undefined;
    if (!existing) {
      throw new AppError(
        'Agent-tool override not found',
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }

    const next: ToolOverride = { ...existing };
    if (settings !== undefined) next.settings = settings;
    if (requiresConfirmation !== undefined) next.requiresConfirmation = requiresConfirmation;

    const toolOverrides = { ...(agent.toolOverrides ?? {}), [toolId]: next };
    await updateAgentToolAccess(agent, { toolOverrides });
    sendOk(res, { toolId, override: next });
  })
);

// DELETE /api/tools/agent/:agentId/:toolId — remove override and from allow list.
router.delete(
  '/agent/:agentId/:toolId',
  asyncHandler(async (req, res) => {
    const { agentId, toolId } = req.params;
    const agent = await loadAgent(agentId);

    const overrides = { ...((agent.toolOverrides ?? {}) as Record<string, ToolOverride>) };
    const hadOverride = toolId in overrides;
    delete overrides[toolId];

    let toolAccessAllowList = agent.toolAccessAllowList;
    if (agent.toolAccessMode === 'allow_list' && Array.isArray(agent.toolAccessAllowList)) {
      toolAccessAllowList = agent.toolAccessAllowList.filter((id) => id !== toolId);
    }

    if (!hadOverride && toolAccessAllowList === agent.toolAccessAllowList) {
      throw new AppError(
        'Agent-tool override not found',
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }

    await updateAgentToolAccess(agent, {
      toolOverrides: overrides,
      ...(toolAccessAllowList !== agent.toolAccessAllowList ? { toolAccessAllowList } : {}),
    });
    sendOk(res, null);
  })
);

export default router;
