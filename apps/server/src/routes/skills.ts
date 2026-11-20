/**
 * Skills API — read-only surface for the Skills sidebar.
 *
 * GET  /api/skills                     — the user's own skills (sorted by slug)
 * GET  /api/skills/:id/files           — files in that skill's folder
 * GET  /api/skills/:id/file?path=rel   — one text file's content
 * POST /api/skills/:id/reveal          — show the folder in Finder (macOS) /
 *                                        the file manager; panel auth only
 *
 * Built-in skills are not part of this surface: they are left out of the list
 * and every `:id` route answers 404 for one, as for an unknown id. Every agent
 * has them without an assignment, so there is nothing to show or pick.
 *
 * There is no create/edit/delete: skills are authored on disk under
 * `~/.snaglet/skills/<slug>/` and the folder scanner keeps the registry in step.
 * Paths are realpath-contained to the skill folder (see skillBrowse.ts).
 */
import { spawn } from 'child_process';
import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware } from '@server/middleware/panelAuth';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import {
  getSkillForUi,
  listSkillFiles,
  listSkillsForUi,
  readSkillFileForUi,
  realFolderOf,
  SkillBrowseError,
} from '@server/services/skills/skillBrowse';
import path from 'path';

const router = Router();

function toAppError(err: unknown): unknown {
  if (!(err instanceof SkillBrowseError)) return err;
  if (err.status === 404) {
    return new AppError(getErrorMessage(err), ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  return new AppError(getErrorMessage(err), ErrorCode.VALIDATION_ERROR, err.status);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toAppError(err);
  }
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    sendOk(res, await listSkillsForUi());
  })
);

router.get(
  '/:id/files',
  asyncHandler(async (req, res) => {
    sendOk(res, await guarded(() => listSkillFiles(req.params.id)));
  })
);

router.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    sendOk(res, await guarded(() => readSkillFileForUi(req.params.id, rel)));
  })
);

/** Platform command that reveals a folder; argv only, never a shell string. */
export function revealCommand(
  folder: string,
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', folder] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${folder}`] };
  return { cmd: 'xdg-open', args: [path.dirname(folder)] };
}

router.post(
  '/:id/reveal',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    // The path comes from the registry row, never from the request, and goes
    // through the same containment check as browse: a gone folder 404s, and a
    // skill folder that symlinks out of the skills root is refused.
    const folder = await guarded(async () => realFolderOf(await getSkillForUi(req.params.id)));
    const { cmd, args } = revealCommand(folder);
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // A missing file manager is not worth a 500; the UI still has Copy path.
    }
    sendOk(res, { revealed: true });
  })
);

export default router;
