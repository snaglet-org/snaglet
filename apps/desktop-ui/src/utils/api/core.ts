/**
 * Core API utilities — URL construction and fetch helpers
 */

import { clientConfig } from '@desktop/config';
import { getErrorMessage } from '@snaglet/shared/utils';
import { withUnloadKeepalive } from '@desktop/utils/unloadFlush';

/**
 * Normalizes URL path by ensuring proper slash handling
 */
function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Constructs full API URL from relative path using environment configuration
 * Handles slash normalization to prevent double slashes or missing slashes
 */
export function getApiUrl(path: string): string {
  if (!path) {
    throw new Error('API path cannot be empty');
  }

  const baseUrl = clientConfig.apiBaseUrl.replace(/\/$/, ''); // Remove trailing slash
  const normalizedPath = normalizePath(path);
  const fullUrl = `${baseUrl}${normalizedPath}`;

  // Relative base (e.g. `/api` in dev via Vite proxy) — `new URL('/api/x')`
  // requires an absolute base and always throws. The path is structurally valid;
  // the Vite proxy forwards it to the server at the right port.
  if (baseUrl.startsWith('/')) {
    return fullUrl;
  }

  try {
    new URL(fullUrl);
    return fullUrl;
  } catch (error) {
    throw new Error(
      `Invalid API URL construction: ${baseUrl} + ${normalizedPath}. ` +
        `${getErrorMessage(error, 'Invalid URL format')}`
    );
  }
}

// The envelope types live in @snaglet/shared/types/api.ts as a discriminated union
// (ApiSuccess<T> | ApiFailure). The fetch helpers below throw on failure, so a
// caller only ever sees the success arm: `ApiResponse<T>` aliases `ApiSuccess<T>`.
//
// Use `fetchData<T>()` for enveloped routes. `fetchJson` is only for endpoints
// that do not wrap responses in the ApiResponse envelope — reading fields off a
// raw envelope through it silently yields undefined.
import type { ApiResponse as ApiEnvelope, ApiSuccess } from '@snaglet/shared/types/api';
export type ApiResponse<T = unknown> = ApiSuccess<T>;

/**
 * Thrown by `fetchJson` on a non-2xx response. To tell responses apart,
 * prefer `.status` over `.message`: the message comes from whatever body the
 * server sent (a JSON envelope's `error.message`, or `HTTP ${status}` when the
 * body isn't JSON), so its exact string isn't a stable contract.
 */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  // A save started by an unload flush (see utils/unloadFlush) is sent as a
  // keepalive request so it completes after the page is gone.
  const res = await fetch(
    url,
    withUnloadKeepalive({
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errObj =
      body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : null;
    const errVal = errObj?.message ?? body.error ?? body.message;
    const errMsg =
      typeof errVal === 'string'
        ? errVal
        : errVal && typeof errVal === 'object'
          ? JSON.stringify(errVal)
          : `HTTP ${res.status}`;
    throw new FetchError(errMsg, res.status, errObj?.details ?? body.details);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch a standard `ApiResponse<T>` envelope and unwrap its `data`, narrowing
 * the discriminated union once at this single point. On `success: false` it
 * throws using the typed failure fields, so callers receive a clean `T` and
 * never touch `.data` on a failure arm.
 *
 * Prefer this over `fetchJson<ApiResponse<T>>(...).then((r) => r.data)`, which
 * cannot narrow the union and accesses `.data` unchecked.
 */
export async function fetchData<T>(url: string, init?: RequestInit): Promise<T> {
  const body = await fetchJson<ApiEnvelope<T>>(url, init);
  if (!body.success) {
    throw new Error(body.error || 'Request failed');
  }
  return body.data;
}
