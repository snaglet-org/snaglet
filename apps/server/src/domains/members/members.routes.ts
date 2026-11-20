/**
 * Members API routes
 *
 * GET /api/members — list assignable principals (agents + human users) as
 *                    { id, kind, displayName }, ordered kind then name.
 *
 * `members` is the unified principal-identity registry (one row per agent,
 * one per user). Doc work-item fields store an assignee as a `members.id`, so
 * the UI's assignee picker needs member ids paired with a human-readable name.
 * This joins each member to its underlying agent/user to resolve that name.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { getDb } from '@snaglet/db';

const router = Router();

interface MemberRawRow {
  id: string;
  kind: string;
  display_name: string;
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    // LEFT JOIN both principal tables and coalesce the name so a member of
    // either kind resolves. Rows whose principal has no resolvable name
    // (dangling id) are dropped so the picker never shows a nameless entry.
    // Subagent helpers stay in: this route resolves createdBy /
    // lastEditedBy names, and a helper may have written the doc. The member
    // picker (Database relations) leaves them out in TableReferencesModel.
    // user_id is cast to text on both sides so the join holds across DB
    // engines regardless of the users.id column type.
    const { rows } = await getDb().query<MemberRawRow>(
      // External members (kind='external', one per MCP API key) carry their
      // name on mcp_api_keys, not agents/users — join it so attribution fields
      // like a doc's "Edited by" resolve to a name instead of a raw member id.
      `SELECT m.id,
              m.kind,
              COALESCE(a.name, u.name, k.name) AS display_name
         FROM public.members m
         LEFT JOIN public.agents a ON a.id = m.agent_id
         LEFT JOIN public.users u ON u.id::text = m.user_id::text
         LEFT JOIN public.mcp_api_keys k ON k.member_id = m.id
        WHERE COALESCE(a.name, u.name, k.name) IS NOT NULL
        ORDER BY m.kind ASC, display_name ASC`
    );
    sendOk(
      res,
      rows.map((r) => ({ id: r.id, kind: r.kind, displayName: r.display_name }))
    );
  })
);

export default router;
