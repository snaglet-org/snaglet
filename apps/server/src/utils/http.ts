import type { Response } from 'express';
import { formatTimestamp } from '@snaglet/shared/utils';
import type { ApiFailure, ApiSuccess } from '@snaglet/shared/types';

// Success/failure envelope shapes are the shared wire schema (ApiSuccess /
// ApiFailure in @snaglet/shared/types/api.ts). Only the data-less success variant
// (sendOkEmpty, e.g. for deletes) is server-local.
type EmptySuccessEnvelope = {
  success: true;
  timestamp: string;
};

function successEnvelope<T>(data: T): ApiSuccess<T> {
  return { success: true, data, timestamp: formatTimestamp() };
}

function emptySuccessEnvelope(): EmptySuccessEnvelope {
  return { success: true, timestamp: formatTimestamp() };
}

function failureEnvelope(error: string, details?: unknown): ApiFailure {
  return {
    success: false,
    error,
    ...(details !== undefined ? { details } : {}),
    timestamp: formatTimestamp(),
  };
}

/** Send a 200 success envelope. */
export function sendOk<T>(res: Response, data: T): Response {
  return res.json(successEnvelope(data));
}

/** Send a 200 success envelope with no payload (e.g. for deletes). */
export function sendOkEmpty(res: Response): Response {
  return res.json(emptySuccessEnvelope());
}

/** Send a 201 created envelope. */
export function sendCreated<T>(res: Response, data: T): Response {
  const body: ApiSuccess<T> = successEnvelope(data);
  return res.status(201).json(body);
}

/** Send a failure envelope with the given status code (default 400). */
export function sendFailure(
  res: Response,
  error: string,
  opts: { status?: number; details?: unknown } = {}
): Response {
  return res.status(opts.status ?? 400).json(failureEnvelope(error, opts.details));
}
