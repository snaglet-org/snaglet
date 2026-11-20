/**
 * Typed client for /api/browser/profiles (Snaglet-owned persistent browser
 * profiles). Tolerates a bare array or an `{success,data}` envelope and
 * reports a missing route (server not updated) as an empty/unavailable state.
 */
import { FetchError, fetchJson, getApiUrl } from '@desktop/utils/api/core';

export interface BrowserProfile {
  id: string;
  name: string;
  exists: boolean;
  running: boolean;
  lastUsedAt: string | number | null;
}

export const MAIN_PROFILE_ID = 'main';

function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/** Narrow an untyped list response to well-formed profiles; drops bad rows. */
export function parseProfiles(body: unknown): BrowserProfile[] {
  const raw = unwrap(body);
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { profiles?: unknown }).profiles)
      ? (raw as { profiles: unknown[] }).profiles
      : [];
  const out: BrowserProfile[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const p = r as Record<string, unknown>;
    if (typeof p.id !== 'string' || p.id.length === 0) continue;
    out.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : p.id,
      exists: p.exists !== false,
      running: p.running === true,
      lastUsedAt:
        typeof p.lastUsedAt === 'string' || typeof p.lastUsedAt === 'number' ? p.lastUsedAt : null,
    });
  }
  return out;
}

export function formatLastUsed(v: BrowserProfile['lastUsedAt']): string {
  if (v === null) return 'Never used';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'Never used' : `Last used ${d.toLocaleString()}`;
}

const enc = encodeURIComponent;

export const browserProfilesApi = {
  /** 404 (route not live yet) resolves to an empty list. */
  async list(): Promise<BrowserProfile[]> {
    try {
      return parseProfiles(await fetchJson<unknown>(getApiUrl('/browser/profiles')));
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) return [];
      throw err;
    }
  },
  async create(name: string): Promise<void> {
    await fetchJson<unknown>(getApiUrl('/browser/profiles'), {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },
  async open(id: string): Promise<void> {
    await fetchJson<unknown>(getApiUrl(`/browser/profiles/${enc(id)}/open`), { method: 'POST' });
  },
  async remove(id: string): Promise<void> {
    await fetchJson<unknown>(getApiUrl(`/browser/profiles/${enc(id)}`), { method: 'DELETE' });
  },
};
