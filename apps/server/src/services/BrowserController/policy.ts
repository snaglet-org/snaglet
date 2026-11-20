import type { ElementInfo } from './types';

export const DANGER_NAME =
  /\b(send|delete|remove|buy|purchase|pay|confirm|submit|post|publish|transfer|empty trash|unsubscribe)\b/i;
const SECRET_LABEL = /password|passcode|card number|cvv|secret|api key|token/i;
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|cc-number|cc-csc)$/i;

export function isSecureField(e: Pick<ElementInfo, 'type' | 'autocomplete' | 'name' | 'attrs'>) {
  if ((e.type ?? '').toLowerCase() === 'password') return true;
  const ac = (e.autocomplete ?? '').trim().toLowerCase();
  if (SECRET_AUTOCOMPLETE.test(ac) || ac.startsWith('cc-')) return true;
  return SECRET_LABEL.test(`${e.name ?? ''} ${e.attrs ?? ''}`);
}

export const isDangerous = (name: string) => DANGER_NAME.test(name);

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, '')
    )
    .filter(Boolean);

const hostMatches = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

/** Returns an error message when the URL is not allowed, else null. */
export function checkSite(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (url === 'about:blank') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'invalid url';
  }
  const allowed = list(env.SNAGLET_BROWSER_ALLOWED_SITES);
  const blocked = list(env.SNAGLET_BROWSER_BLOCKED_SITES);
  if (u.protocol === 'data:') {
    return allowed.length ? 'data: urls are not allowed while an allowlist is set' : null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `${u.protocol} urls are not allowed`;
  }
  const host = u.hostname.toLowerCase();
  if (blocked.some((s) => hostMatches(host, s)))
    return `${host} is blocked (SNAGLET_BROWSER_BLOCKED_SITES)`;
  if (allowed.length && !allowed.some((s) => hostMatches(host, s))) {
    return `${host} is not in the allowed sites (SNAGLET_BROWSER_ALLOWED_SITES)`;
  }
  return null;
}

export const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') ? u.hostname : u.protocol;
  } catch {
    return '?';
  }
};
