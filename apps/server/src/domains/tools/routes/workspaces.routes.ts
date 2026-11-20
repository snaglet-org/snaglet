import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk, sendCreated } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, formatTimestamp } from '@snaglet/shared/utils';
import { Tools } from '@snaglet/db/tables/tools';
import { toolWorkspaceService } from '@server/services/ToolService/ToolWorkspaceService';
import {
  withCustomToolRemove,
  withCustomToolUpsert,
} from '@server/services/ToolService/customTools/CustomToolScanner';
import { decorateToolRow, syncDefinitionToDb } from './helpers';

const router = Router();

// GET /api/tools/workspaces — list all tool workspaces
router.get(
  '/workspaces',
  asyncHandler(async (_req, res) => {
    const workspaces = toolWorkspaceService.listAll();
    sendOk(res, workspaces);
  })
);

// GET /api/tools/workspaces/:toolId — get workspace info
router.get(
  '/workspaces/:toolId',
  asyncHandler(async (req, res) => {
    if (!toolWorkspaceService.exists(req.params.toolId)) {
      throw new AppError('Workspace not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const info = toolWorkspaceService.getInfo(req.params.toolId);
    sendOk(res, info);
  })
);

// GET /api/tools/workspaces/:toolId/files/:fileName — read a file from a workspace
router.get(
  '/workspaces/:toolId/files/:fileName',
  asyncHandler(async (req, res) => {
    const content = toolWorkspaceService.readFile(req.params.toolId, req.params.fileName);
    sendOk(res, { content });
  })
);

// POST /api/tools/workspaces — create a new tool workspace + register as draft in DB
router.post(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const { toolId, files } = req.body as {
      toolId?: string;
      files?: { 'definition.json': string; 'tool.ts': string; 'TOOL.md': string };
    };
    if (!toolId || !files) {
      throw new AppError(
        'toolId and files are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const folderName = toolWorkspaceService.getFolderName(toolId);
    const { info, tool } = await withCustomToolUpsert(folderName, async (checkpointSource) => {
      const info = await toolWorkspaceService.create(toolId, files);
      const commitFingerprint = await checkpointSource();
      const tool = await syncDefinitionToDb(toolId, files['definition.json'], { enabled: false });
      commitFingerprint();
      return { info, tool };
    });
    sendCreated(res, { workspace: info, tool: await decorateToolRow(tool) });
  })
);

// PUT /api/tools/workspaces/:toolId/files — update files + re-sync definition to DB
router.put(
  '/workspaces/:toolId/files',
  asyncHandler(async (req, res) => {
    const files = req.body as Partial<{
      'definition.json': string;
      'tool.ts': string;
      'TOOL.md': string;
    }>;
    const { toolId } = req.params;
    const folderName = toolWorkspaceService.getFolderName(toolId);
    const { info, tool } = await withCustomToolUpsert(folderName, async (checkpointSource) => {
      const info = await toolWorkspaceService.updateFiles(toolId, files);
      const commitFingerprint = await checkpointSource();

      // If definition.json was updated, re-sync to DB (keep current enabled state)
      let tool = null;
      if (files['definition.json']) {
        const existing = await Tools.findBySource(`workspace:${toolId}`);
        const wasEnabled = existing?.enabled ?? false;
        tool = await syncDefinitionToDb(toolId, files['definition.json'], {
          enabled: wasEnabled,
        });
      }
      commitFingerprint();
      return { info, tool };
    });

    sendOk(res, { workspace: info, tool: tool && (await decorateToolRow(tool)) });
  })
);

// POST /api/tools/workspaces/:toolId/install — install dependencies
router.post(
  '/workspaces/:toolId/install',
  asyncHandler(async (req, res) => {
    const result = await toolWorkspaceService.install(req.params.toolId);
    sendOk(res, result);
  })
);

// POST /api/tools/workspaces/:toolId/build — build the tool
router.post(
  '/workspaces/:toolId/build',
  asyncHandler(async (req, res) => {
    const result = await toolWorkspaceService.build(req.params.toolId);
    sendOk(res, result);
  })
);

// POST /api/tools/workspaces/:toolId/deploy — full pipeline: install + build + activate in DB
router.post(
  '/workspaces/:toolId/deploy',
  asyncHandler(async (req, res) => {
    const { toolId } = req.params;
    const folderName = toolWorkspaceService.getFolderName(toolId);

    await withCustomToolUpsert(folderName, async (checkpointSource) => {
      // Capture the source the pipeline is about to build. Commit it only if
      // install, build, and DB activation all succeed.
      const commitFingerprint = await checkpointSource();
      const installResult = await toolWorkspaceService.install(toolId);
      if (!installResult.success) {
        res.json({
          data: { step: 'install', ...installResult },
          success: false,
          timestamp: formatTimestamp(),
        });
        return;
      }

      const buildResult = await toolWorkspaceService.build(toolId);
      if (!buildResult.success) {
        res.json({
          data: { step: 'build', ...buildResult },
          success: false,
          timestamp: formatTimestamp(),
        });
        return;
      }

      // Activate the tool in the DB with workspace execution config
      const defContent = toolWorkspaceService.readFile(toolId, 'definition.json');
      const info = toolWorkspaceService.getInfo(toolId);
      const toolRow = await syncDefinitionToDb(toolId, defContent, {
        enabled: true,
        configJson: {
          workspace_tool: true,
          workspace_dir: info.dir,
          built_path: toolWorkspaceService.getBuiltToolPath(toolId),
        },
      });
      commitFingerprint();
      sendOk(res, {
        tool: await decorateToolRow(toolRow),
        install: installResult,
        build: buildResult,
      });
    });
  })
);

// DELETE /api/tools/workspaces/:toolId — delete a workspace
router.delete(
  '/workspaces/:toolId',
  asyncHandler(async (req, res) => {
    const { toolId } = req.params;
    const folderName = toolWorkspaceService.getFolderName(toolId);
    await withCustomToolRemove(folderName, async () => toolWorkspaceService.delete(toolId));
    sendOk(res, null);
  })
);

export default router;
