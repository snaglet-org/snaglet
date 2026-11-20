/**
 * Client environment configuration
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { setPanelToken } from './utils/panelToken';

export interface ClientConfig {
  apiBaseUrl: string;
  appName: string;
}

/**
 * Runtime config injected by the desktop shell. When the Tauri
 * shell spawns the server sidecar on a random loopback port it injects
 * `window.__SNAGLET_DESKTOP__ = { apiBaseUrl, token, panelToken }` via an
 * initialization script before any app code runs — the build-time VITE_*
 * values can't know the per-session port. `token` authenticates /api +
 * WebSocket calls (see utils/api/core.ts and ws/WebSocketContext.tsx).
 * `panelToken` separately gates only the tool-execution routes (see
 * utils/panelToken.ts and the server's middleware/panelAuth.ts) — outside the
 * packaged shell (Vite dev mode) it arrives later instead, over the
 * WebSocket, and is set via setPanelToken from WebSocketContext.tsx.
 */
interface DesktopRuntimeConfig {
  apiBaseUrl?: string;
  appName?: string;
  token?: string;
  panelToken?: string;
}

const desktopRuntime: DesktopRuntimeConfig | undefined = (
  globalThis as { __SNAGLET_DESKTOP__?: DesktopRuntimeConfig }
).__SNAGLET_DESKTOP__;

/** Sidecar session token, or null outside the packaged desktop shell. */
export const desktopSessionToken: string | null = desktopRuntime?.token ?? null;

// Seed the panel-token holder synchronously from the Tauri-injected value, if
// any. Outside the packaged shell this is null until WebSocketContext.tsx
// receives the server's post-connect push (see utils/panelToken.ts's module
// doc for the full picture).
setPanelToken(desktopRuntime?.panelToken ?? null);

function getEnv(name: string): string | undefined {
  // Vite uses import.meta.env, Jest uses process.env
  if (
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env === 'object'
  ) {
    return import.meta.env[name];
  }
  return process.env[name];
}

function loadClientConfig(): ClientConfig {
  // Desktop shell runtime config wins — the sidecar port is per-session.
  if (desktopRuntime?.apiBaseUrl) {
    return {
      apiBaseUrl: desktopRuntime.apiBaseUrl,
      appName: desktopRuntime.appName ?? 'Snaglet',
    };
  }

  const apiBaseUrl = getEnv('VITE_API_BASE_URL');
  const appName = getEnv('VITE_APP_NAME');

  if (!apiBaseUrl || !appName) {
    const missingVars = [];
    if (!apiBaseUrl) missingVars.push('VITE_API_BASE_URL');
    if (!appName) missingVars.push('VITE_APP_NAME');
    throw new Error(
      `Missing environment variables: ${missingVars.join(', ')}\nCheck your .env.local file.`
    );
  }

  // Dev: a relative base (`/api`) means the browser hits the Vite origin and
  // the dev-server proxy forwards to the server — there's no absolute URL to
  // validate. Prod uses the desktop runtime handoff above; any non-relative
  // value here must be a full http(s) URL.
  if (!apiBaseUrl.startsWith('/')) {
    try {
      const url = new URL(apiBaseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Must be HTTP or HTTPS');
      }
    } catch (error) {
      throw new Error(`Invalid VITE_API_BASE_URL: ${apiBaseUrl}. ${getErrorMessage(error, '')}`);
    }
  }

  return { apiBaseUrl, appName };
}

export const clientConfig = loadClientConfig();

/**
 * localStorage key holding the active (declared) user id selected in
 * settings → profile. This is *declared identity*, not auth: the server
 * validates the id maps to a real users row but does not verify ownership.
 * See apps/server/src/middleware/actorContext.ts (readDeclaredUser).
 */
export const ACTIVE_USER_ID_KEY = 'snaglet.activeUserId';
export const ACTIVE_USER_CHANGED_EVENT = 'snaglet:active-user-changed';

/** Read the persisted declared user id, or null if none selected yet. */
export function getActiveUserId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_USER_ID_KEY);
  } catch {
    return null;
  }
}

export function setActiveUserId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_USER_ID_KEY, id);
    window.dispatchEvent(new CustomEvent(ACTIVE_USER_CHANGED_EVENT, { detail: { id } }));
  } catch {
    // Storage unavailable (private mode etc.) — identity simply stays unset.
  }
}

// Transparently attach identity/session headers to every API-base fetch.
// One wrapper here covers fetchJson and the handful of direct fetch() call
// sites without per-site changes:
//   - x-snaglet-token     : sidecar session token (packaged desktop shell only)
//   - x-snaglet-actor-id  : declared user identity (picker selection, both dev
//                           browser and packaged shell) — binds change-log
//                           attribution to the chosen user instead of `system`.
// WebSocket connects carry the token in the URL instead
// (ws/WebSocketContext.tsx) — browsers can't set headers on WS upgrades.
if (typeof window !== 'undefined') {
  const origFetch = window.fetch.bind(window);
  const apiBase = clientConfig.apiBaseUrl.replace(/\/$/, '');
  // Dev base is the relative `/api`; prod base is an absolute `origin/api`.
  // Match API-base requests in both forms: a fetch input can be a relative
  // string (`/api/x`) or a fully resolved absolute URL (Request.url / URL.href
  // expose the origin). For the relative base, compare by pathname so both
  // resolve the same; for an absolute base, use a prefix match.
  const isRelativeBase = apiBase.startsWith('/');
  const targetsApiBase = (url: string): boolean => {
    if (!isRelativeBase) return url.startsWith(apiBase);
    try {
      const { pathname } = new URL(url, window.location.origin);
      return pathname === apiBase || pathname.startsWith(`${apiBase}/`);
    } catch {
      return false;
    }
  };
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (targetsApiBase(url)) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined)
        );
        if (desktopSessionToken) {
          headers.set('x-snaglet-token', desktopSessionToken);
        }
        const activeUserId = getActiveUserId();
        if (activeUserId) {
          headers.set('x-snaglet-actor-id', activeUserId);
        }
        return origFetch(input, { ...init, headers });
      }
    } catch {
      // Malformed input — let the original fetch produce the real error.
    }
    return origFetch(input, init);
  };
}
