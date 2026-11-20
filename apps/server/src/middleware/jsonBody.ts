import express, { type RequestHandler } from 'express';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, formatBytes, isRecord } from '@snaglet/shared/utils';

const JSON_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const parseJson = express.json({ limit: JSON_BODY_LIMIT_BYTES });

/** POST /api/images, the upload route mounted in index.ts. */
const IMAGE_UPLOAD_PATH_RE = /^\/api\/images\/?$/i;

/** True for the body parser's error when a body is over its limit. */
export function isBodyTooLarge(err: unknown): boolean {
  return isRecord(err) && err.type === 'entity.too.large';
}

/**
 * The API-wide JSON body parser. A body over its limit gets a 413 that names
 * the limit. Image uploads are skipped: the images router parses them itself
 * with a larger limit, after auth, so only that route accepts bodies past 8 MB.
 */
export const jsonBody: RequestHandler = (req, res, next) => {
  if (req.method === 'POST' && IMAGE_UPLOAD_PATH_RE.test(req.path)) {
    next();
    return;
  }
  parseJson(req, res, (err?: unknown) => {
    if (isBodyTooLarge(err)) {
      next(
        new AppError(
          `This request is too large. Requests can be up to ${formatBytes(JSON_BODY_LIMIT_BYTES)}.`,
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.PAYLOAD_TOO_LARGE
        )
      );
      return;
    }
    next(err);
  });
};
