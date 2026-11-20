/**
 * External MCP client connection management (MCP → Client connections).
 *
 * GET    /api/mcp-keys            — list keys (name, created, last used)
 * POST   /api/mcp-keys            — mint a key: creates the external member +
 *                                   key row, returns the plaintext token ONCE
 * PATCH  /api/mcp-keys/:id        — rename a client connection
 * POST   /api/mcp-keys/:id/revoke — revoke (key stops authenticating)
 * GET    /api/mcp-keys/connect-info — McpConnectInfo: this Snaglet's home, profile,
 *                                   `snaglet` command and port, for the pane's
 *                                   ready-to-paste setup (no secrets)
 *
 * Like every /api route these sit behind the app session (sidecarAuth), and
 * /api/mcp-keys is a sensitive path (no cross-site callers). An MCP key never
 * authenticates here: it is accepted only by /mcp.
 * The plaintext token is never stored or listed — only its SHA-256 hash.
 * Each key maps to its own members row (kind='external') so attribution is
 * per-key; revocation deletes the key but retains the member for history.
 */

import { Router } from 'express';
import { McpApiKeys, Members } from '@snaglet/db';
import type { McpApiKeyRow } from '@snaglet/db';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { generateMcpKeyToken, hashMcpKeyToken } from './mcpAuth';
import { mcpConnectInfo } from './mcpConnectInfo';

/** Public projection — never exposes key_hash. */
function toPublicKey(row: McpApiKeyRow) {
  return {
    id: row.id,
    memberId: row.memberId,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const keys = await McpApiKeys.listAll();
    sendOk(res, keys.map(toPublicKey));
  })
);

router.get(
  '/connect-info',
  asyncHandler(async (_req, res) => {
    sendOk(res, mcpConnectInfo());
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      throw new AppError(
        'A key name is required (it labels the client, e.g. "Claude Code").',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const member = await Members.createExternal();
    const token = generateMcpKeyToken();
    const key = await McpApiKeys.create({
      memberId: member.id,
      name,
      keyHash: hashMcpKeyToken(token),
    });

    // `token` is shown exactly once — it is never retrievable again.
    sendCreated(res, { key: toPublicKey(key), token });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      throw new AppError(
        'A client connection name is required.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const renamed = await McpApiKeys.rename(req.params.id, name);
    if (!renamed) {
      throw new AppError('Client connection not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, toPublicKey(renamed));
  })
);

router.post(
  '/:id/revoke',
  asyncHandler(async (req, res) => {
    const revoked = await McpApiKeys.revoke(req.params.id);
    if (!revoked) {
      throw new AppError('Client connection not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, toPublicKey(revoked));
  })
);

export default router;
