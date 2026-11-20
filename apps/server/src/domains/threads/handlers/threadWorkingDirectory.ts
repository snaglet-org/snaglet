import type { Router } from 'express';
import { Threads } from '@snaglet/db/tables/threads';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware } from '@server/middleware/panelAuth';
import { sendOk } from '@server/utils/http';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import { validateThreadWorkingDirectory } from '@server/services/ToolService/lib/threadWorkingDirectory';
import { describeAgentCwd } from '@server/services/ToolService/lib/resolveAgentCwd';

/**
 * The person's own setter: it needs the real panel credential, since attribution
 * headers and child-dispatch credentials grant no authority. Agents change the
 * same setting through `thread` op:update (thread.working_directory), which runs
 * the same folder checks.
 */
export function registerThreadWorkingDirectoryRoutes(router: Router): void {
  // What the settings screen shows: this thread's own saved folder, the folder
  // agents will actually start in, and where that came from (a saved thread
  // folder, the project's folder, or Snaglet home).
  router.get(
    '/:id/working-directory',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread)
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      const described = await describeAgentCwd(thread.id);
      sendOk(res, {
        id: thread.id,
        working_directory: thread.workingDirectory ?? null,
        effective: described.path,
        source: described.source,
        project_folder: described.projectFolder,
        inherited_override: thread.workingDirectory == null ? described.override : null,
        override_problem: described.overrideProblem,
      });
    })
  );

  router.put(
    '/:id/working-directory',
    panelAuthMiddleware,
    asyncHandler(async (req, res) => {
      if (req.toolExecuteAuthScope !== 'panel') {
        throw new AppError(
          'Person authentication required',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      const thread = await Threads.findById(req.params.id);
      if (!thread)
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      const value = req.body?.working_directory;
      if (value === undefined) {
        throw new AppError(
          'working_directory is required (null clears)',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      let directory: string | null = null;
      if (value !== null) {
        const project = await findProjectAncestor(thread.id);
        try {
          directory = await validateThreadWorkingDirectory(value, project?.folderPath ?? null);
        } catch (error) {
          throw new AppError(
            getErrorMessage(error, 'Invalid working directory'),
            ErrorCode.VALIDATION_ERROR,
            HTTP_STATUS.BAD_REQUEST
          );
        }
      }
      const updated = await Threads.setWorkingDirectory(thread.id, directory);
      sendOk(res, { id: thread.id, working_directory: updated?.workingDirectory ?? null });
    })
  );
}
