import type { Request } from 'express';
import { Agents } from '@snaglet/db/tables/agents';
import { AppError, asNonEmptyString } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { getCurrentActor } from '@server/realtime/actorContext';
import { verifyChildDispatchToken } from '@server/middleware/panelAuth';

/** Verified child identity wins over the desktop's declared person identity. */
export async function participantCallingAgent(req: Request): Promise<string | undefined> {
  const token = req.get('x-snaglet-child-dispatch-token');
  if (token !== undefined) {
    const verified = verifyChildDispatchToken(token);
    if (!verified?.agentId) {
      throw new AppError('Invalid agent caller', ErrorCode.FORBIDDEN, HTTP_STATUS.FORBIDDEN);
    }
    return verified.agentId;
  }
  if (req.childDispatchAgentId) return req.childDispatchAgentId;
  const actor = getCurrentActor();
  if (actor?.actorKind === 'agent') return actor.actorId;

  // Older REST clients declare an agent in the audit fields; never treat
  // that request as a person simply because desktop middleware fell back.
  const declaredAgent =
    asNonEmptyString(req.query.actorAgentId) ??
    asNonEmptyString((req.body as { actorAgentId?: unknown } | undefined)?.actorAgentId);
  if (declaredAgent) return declaredAgent;
  const declaredId = req.get('x-snaglet-actor-id')?.trim();
  if (declaredId && (await Agents.findById(declaredId))) return declaredId;
  return undefined;
}
