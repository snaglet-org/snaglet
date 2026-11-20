/**
 * Export API — `POST /api/export`.
 *
 * The human-facing door onto ExportService. Two shapes, chosen by whether the
 * client can name a destination:
 *
 *  - **`destDir` present** (Tauri): the server writes the file and returns
 *    where it landed. The path is guarded in `ExportService/exportPaths`.
 *  - **`destDir` absent** (browser): the server writes nothing and streams the
 *    bytes back for a normal download. This is not a degraded write path; it
 *    is the only correct behavior when the client cannot supply a real folder.
 *
 * Identity rules this route owns:
 *  - `agent_memories` requires an authenticated human actor. A person may
 *    export a selected agent's memories from the app; nothing else reaching
 *    this route may. Agents get memory export through the internal tool, bound
 *    to their own id — never through here.
 *  - `overwrite` is passed through, but ExportService only honors it for a
 *    `user` actor, so a non-human caller cannot clobber by asking nicely.
 *  - `exported_by` is never read from the request. See ExportService.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { sendOk } from '@server/utils/http';
import { getCurrentActor } from '@server/realtime/actorContext';
import { EXPORT_KINDS, runExport, type ExportKind } from '@server/services/ExportService';

const router = Router();

function badRequest(message: string): never {
  throw new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** RFC 5987 — keeps non-ASCII titles intact without breaking older clients. */
export function contentDisposition(fileName: string): string {
  // The ASCII fallback must not contain a quote or a control character, or it
  // terminates the header value early.
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

interface ExportBody {
  kind?: unknown;
  id?: unknown;
  destDir?: unknown;
  fileName?: unknown;
  options?: { messageLimit?: unknown; overwriteGrant?: unknown };
}

function readKind(value: unknown): ExportKind {
  if (typeof value !== 'string' || !EXPORT_KINDS.includes(value as ExportKind)) {
    badRequest(`kind must be one of: ${EXPORT_KINDS.join(', ')}`);
  }
  return value as ExportKind;
}

function readMessageLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    badRequest('options.messageLimit must be a positive integer');
  }
  return n;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as ExportBody;
    const kind = readKind(body.kind);
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) badRequest('id is required');

    const actor = getCurrentActor();
    const destDir = typeof body.destDir === 'string' ? body.destDir : undefined;

    // Recursive container export is the human sidebar action. It is
    // intentionally absent from the agent tool and external MCP kind list;
    // defend the HTTP door too so adding the service kind cannot widen access.
    if (kind === 'container') {
      if (actor?.actorKind !== 'user') {
        throw new AppError(
          'Exporting a container requires an authenticated person.',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      if (!destDir?.trim()) badRequest('destDir is required for container exports');
    }

    // Only a person may export an agent's memories through the HTTP surface.
    // The internal tool binds agents to their own id; there is deliberately no
    // path here that lets a non-human name an agent.
    let allowedAgentId: string | null | undefined;
    if (kind === 'agent_memories') {
      if (actor?.actorKind !== 'user') {
        throw new AppError(
          'Exporting an agent’s memories requires an authenticated person.',
          ErrorCode.FORBIDDEN,
          HTTP_STATUS.FORBIDDEN
        );
      }
      allowedAgentId = id;
    }

    const { result, payload } = await runExport({
      kind,
      id,
      destDir,
      fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
      options: {
        messageLimit: readMessageLimit(body.options?.messageLimit),
        // Forwarded opaquely: the route does not decide anything about
        // overwriting. ExportService verifies the signature against the exact
        // path it is about to write, which is the only place that check is
        // meaningful. A body carrying no grant simply cannot overwrite.
        overwriteGrant:
          typeof body.options?.overwriteGrant === 'string'
            ? body.options.overwriteGrant
            : undefined,
      },
      allowedAgentId,
    });

    if (result.downloaded) {
      if (!payload) {
        throw new AppError(
          'Export produced no downloadable payload.',
          ErrorCode.INTERNAL_ERROR,
          HTTP_STATUS.INTERNAL_SERVER_ERROR
        );
      }
      // Bytes only — nothing was written, and the response says so by being a
      // file body rather than a JSON envelope naming a path.
      res.setHeader('Content-Type', payload.contentType);
      res.setHeader('Content-Disposition', contentDisposition(result.fileName));
      res.setHeader('Content-Length', String(payload.data.byteLength));
      res.send(payload.data);
      return;
    }

    sendOk(res, result);
  })
);

export default router;
