/**
 * Chat profile route.
 *
 * Returns the resolved user id. The PUT handler accepts an avatar payload
 * but does not persist profile images yet.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { Users } from '@snaglet/db/tables/users';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';

const router = Router();

function getDeclaredUserId(req: Request): number | null {
  const raw = req.headers['x-snaglet-actor-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function getProfileIdForRequest(req: Request): Promise<string> {
  const declaredUserId = getDeclaredUserId(req);
  if (declaredUserId && (await Users.findById(declaredUserId))) {
    return String(declaredUserId);
  }

  const local = await Users.getOrCreateLocalUser();
  return String(local.id);
}

router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const id = await getProfileIdForRequest(req);
    sendOk(res, { id });
  })
);

router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    // Keep avatar payloads non-breaking while profile-image persistence lives
    // outside this route.
    const id = await getProfileIdForRequest(req);
    sendOk(res, { id });
  })
);

export default router;
