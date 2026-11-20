/**
 * Panel execution token, held in memory only. It gates the tool-execution
 * routes (act_as impersonation and arbitrary code execution; see the server's
 * middleware/panelAuth.ts). It never arrives in an HTTP response body: the
 * packaged app gets it from `window.__SNAGLET_DESKTOP__.panelToken` (injected by
 * the Tauri shell before any page script runs, read in config.ts), and Vite
 * dev mode gets a `panel-token` push over the WebSocket (WebSocketContext.tsx).
 * A separate module so both can import it without a circular dependency.
 */

let panelToken: string | null = null;

/** Set/replace the current panel token (called once at boot from config.ts, and again whenever WebSocketContext receives a fresh `panel-token` push). */
export function setPanelToken(next: string | null): void {
  panelToken = next;
}

/** The current panel token, or null if none has been delivered yet (e.g. dev mode before the WS connects). */
function getPanelToken(): string | null {
  return panelToken;
}

/**
 * JSON request headers for panel-authenticated routes.
 *
 * `Content-Type` stays explicit because `fetchJson` replaces its default
 * headers whenever a caller supplies `RequestInit.headers`.
 */
export function getPanelJsonHeaders(): Record<string, string> {
  const token = getPanelToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'X-Snaglet-Panel-Token': token } : {}),
  };
}
