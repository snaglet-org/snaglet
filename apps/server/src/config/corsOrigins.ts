import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import {
  DEFAULT_DEV_CLIENT_PORT,
  DEFAULT_PREVIEW_CLIENT_PORT,
} from '../../../../scripts/lib/dev-ports.mjs';

/**
 * Allowed browser origins for the API. Reflecting any origin would let any
 * website the user visits call the local API and read the response (provider
 * keys, DB), so only the local UI (dev Vite, preview, and same-origin packaged
 * builds) and the desktop webview may call in.
 *
 * A request with no Origin header (same-origin fetch, native runtime, curl,
 * server-to-server) is always allowed — CORS only governs cross-origin browser
 * reads. Extra origins can be added with SNAGLET_ALLOWED_ORIGINS (comma-separated)
 * for intentional setups (e.g. a second UI host).
 */
export function buildAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();

  const clientPort = Number.parseInt(env.CLIENT_PORT ?? '', 10);
  const ports = [
    Number.isFinite(clientPort) ? clientPort : DEFAULT_DEV_CLIENT_PORT,
    DEFAULT_DEV_CLIENT_PORT,
    DEFAULT_PREVIEW_CLIENT_PORT,
  ];
  for (const port of ports) {
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }

  // Tauri desktop webview origins (v2 varies by platform).
  origins.add('tauri://localhost');
  origins.add('http://tauri.localhost');
  origins.add('https://tauri.localhost');

  for (const extra of (env.SNAGLET_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  return origins;
}

/**
 * Express `cors` origin callback: allow no-Origin + allowlisted, reject the
 * rest. The rejection is an operational 403 AppError, so the global error
 * handler answers 403 with a short message instead of logging a stack trace
 * and returning 500 for what is an expected, client-caused refusal.
 */
export function corsOriginCheck(
  allowed: Set<string>
): (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => void {
  return (origin, cb) => {
    if (!origin || allowed.has(origin)) {
      cb(null, true);
      return;
    }
    cb(
      new AppError(
        `Origin not allowed by CORS: ${origin}`,
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      )
    );
  };
}
