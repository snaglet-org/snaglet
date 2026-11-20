import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { runWithActor } from '@server/realtime/actorContext';
import { Users } from '@snaglet/db/tables/users';
import { logger } from '@server/config/logger';

/**
 * Declared-identity fallback (no-auth / desktop mode).
 *
 * The client may declare which user it is acting as via `x-snaglet-actor-id` (set
 * from the settings user-picker, persisted in localStorage, stamped in
 * desktop-ui/src/config.ts alongside the sidecar token). This is declared,
 * validated identity: we confirm the id maps to a real users row.
 *
 * Validating against the users table stops table history and audit rows
 * from recording arbitrary / non-existent actor ids. An unrecognized or missing id falls
 * through to `system` — the honest answer for a truly unidentified request.
 */
async function readDeclaredUser(
  req: Request
): Promise<{ actorId: string; actorName: string } | undefined> {
  const raw = req.headers['x-snaglet-actor-id'];
  const declaredId = Array.isArray(raw) ? raw[0] : raw;
  if (!declaredId || declaredId.trim() === '') return undefined;

  try {
    const row = await Users.findById(declaredId);
    if (!row) return undefined;
    return { actorId: String(row.id), actorName: row.name ?? row.email };
  } catch (err) {
    logger.warn('actorContext: declared-user lookup failed', { err });
    return undefined;
  }
}

async function readActiveDbUser(): Promise<{ actorId: string; actorName: string } | undefined> {
  try {
    const row = await Users.getActiveUser();
    if (!row) return undefined;
    return { actorId: String(row.id), actorName: row.name ?? row.email };
  } catch (err) {
    logger.warn('actorContext: active-user lookup failed', { err });
    return undefined;
  }
}

export const actorContextMiddleware: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  void (async () => {
    const actor = (await readDeclaredUser(req)) ?? (await readActiveDbUser());
    if (!actor) {
      next();
      return;
    }
    runWithActor({ actorKind: 'user', actorId: actor.actorId, actorName: actor.actorName }, () =>
      next()
    );
  })();
};
