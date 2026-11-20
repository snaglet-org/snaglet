/**
 * Browser-boundary guards run by `sidecarAuthMiddleware` ahead of the token
 * check, so they also protect the tokenless dev and self-host modes.
 *
 * Host allowlist: with no token, a page could rebind its hostname to 127.0.0.1
 * and read responses as same-origin (no Origin header, so CORS never runs). It
 * cannot change the Host header, so a Host we don't serve gets 421. Routes that
 * return or mint secrets also refuse cross-site callers.
 */

import net from 'net';
import type { Request } from 'express';
import { buildAllowedOrigins } from '@server/config/corsOrigins';

const WILDCARD_BIND_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/** Routes that return or mint secrets. Matched against the lowercased path. */
const SENSITIVE_API_PATHS: readonly RegExp[] = [
  /^\/api\/providers\/credentials\/[^/]+\/export\/?$/,
  /^\/api\/providers\/google-workspace\/client-config\/?$/,
  /^\/api\/mcp-keys(\/|$)/,
  /^\/api\/admin\/db(\/|$)/,
  /^\/api\/db(\/|$)/,
  // Machine control: a foreign page must not drive the cursor or the browser.
  // The native overlay's kill-switch POST has no Origin and no Sec-Fetch-Site,
  // so it is treated as a non-browser client and still passes.
  /^\/api\/computer(\/|$)/,
  /^\/api\/browser(\/|$)/,
];

/**
 * Hostname (lowercase, IPv6 without brackets) from a Host header value, or
 * null when the value is malformed.
 */
export function hostnameFromHostHeader(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    const inner = host.slice(1, end);
    return net.isIPv6(inner) ? inner : null;
  }
  const match = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(host);
  return match ? match[1] : null;
}

function hostnameOfUrl(value: string): string | null {
  try {
    const { hostname } = new URL(value);
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    return bare ? bare.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Configured hostnames beyond loopback and IP literals: SNAGLET_BIND_HOST, the
 * API_BASE_URL host, the CORS allowlist hosts and SNAGLET_ALLOWED_HOSTS
 * (comma-separated, for a reverse proxy or a named host).
 */
export function buildAllowedHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>(['localhost']);

  const bindHost = (env.SNAGLET_BIND_HOST ?? '').trim().toLowerCase();
  if (!WILDCARD_BIND_HOSTS.has(bindHost)) hosts.add(bindHost.replace(/^\[|\]$/g, ''));

  const apiHost = env.API_BASE_URL ? hostnameOfUrl(env.API_BASE_URL) : null;
  if (apiHost) hosts.add(apiHost);

  for (const origin of buildAllowedOrigins(env)) {
    const originHost = hostnameOfUrl(origin);
    if (originHost) hosts.add(originHost);
  }

  for (const entry of (env.SNAGLET_ALLOWED_HOSTS ?? '').split(',')) {
    const hostname = entry.trim() ? hostnameFromHostHeader(entry) : null;
    if (hostname) hosts.add(hostname);
  }

  return hosts;
}

/**
 * Whether a request carrying this Host header may be served: `localhost` and
 * `*.localhost` (Tauri's `tauri.localhost`), any IP literal (nothing to rebind,
 * so LAN self-hosting works), or a configured host. Takes the raw header, never
 * `req.hostname`, which trusts X-Forwarded-Host. No Host means not a browser.
 */
export function isAllowedHostHeader(
  hostHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (hostHeader === undefined) return true;
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  if (net.isIP(hostname) !== 0) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return buildAllowedHostnames(env).has(hostname);
}

export function isSensitiveApiPath(lowercasePath: string): boolean {
  return SENSITIVE_API_PATHS.some((pattern) => pattern.test(lowercasePath));
}

/**
 * True when a browser made this request on behalf of a page on another site:
 * an Origin that is neither allowlisted nor this host, or, with no Origin,
 * `Sec-Fetch-Site: cross-site` (a navigation, `<img>` or form). Non-browser
 * clients (no Origin, no Sec-Fetch-Site) are never cross-site.
 */
export function isCrossSiteRequest(
  req: Pick<Request, 'headers'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    if (buildAllowedOrigins(env).has(origin)) return false;
    const host = req.headers.host;
    // Safe only because the Host allowlist already ran: a same-host Origin
    // here is one of our own hosts, not a rebound attacker domain.
    return !(host && (origin === `http://${host}` || origin === `https://${host}`));
  }
  return req.headers['sec-fetch-site'] === 'cross-site';
}
