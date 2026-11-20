/**
 * UI-side client for the typed /api/settings endpoints.
 */

import { fetchData, getApiUrl, fetchJson } from './core';
import type {
  SettingsOverrideRecord,
  SettingsRegistryRecord,
  SettingsValueRecord,
} from '@snaglet/shared/types';

/** Re-export the wire shapes so callers don't dig through @snaglet/shared/types. */
export type { SettingsRegistryRecord };

/**
 * A provider+model pair naming the model that writes an agent's summaries —
 * the value shape of each entry in the `agent.summary_model_overrides` map.
 * Mirrors the server-side schema in
 * apps/server/src/services/settings/categories/agent.ts.
 */
export interface UtilityModelRef {
  providerId: string;
  modelId: string;
  credentialId?: string | null;
}

/** Narrow an untyped settings `current` value to a UtilityModelRef. */
function asUtilityModelRef(value: unknown): UtilityModelRef | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return typeof v.providerId === 'string' &&
    v.providerId.length > 0 &&
    typeof v.modelId === 'string' &&
    v.modelId.length > 0
    ? {
        providerId: v.providerId,
        modelId: v.modelId,
        credentialId: typeof v.credentialId === 'string' ? v.credentialId : null,
      }
    : null;
}

/**
 * Narrow an untyped `agent.summary_model_overrides` value (agent id →
 * UtilityModelRef) — malformed entries are dropped rather than propagated.
 */
export function asAgentUtilityModels(value: unknown): Record<string, UtilityModelRef> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, UtilityModelRef> = {};
  for (const [agentId, ref] of Object.entries(value as Record<string, unknown>)) {
    const parsed = asUtilityModelRef(ref);
    if (parsed) out[agentId] = parsed;
  }
  return out;
}

/**
 * Narrow an untyped `agent.thread_summary_model_overrides` value (thread id →
 * agent id → UtilityModelRef). Malformed entries are dropped; empty
 * per-thread maps are kept out of the result.
 */
export function asThreadAgentUtilityModels(
  value: unknown
): Record<string, Record<string, UtilityModelRef>> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, Record<string, UtilityModelRef>> = {};
  for (const [threadId, byAgent] of Object.entries(value as Record<string, unknown>)) {
    const agents = asAgentUtilityModels(byAgent);
    if (Object.keys(agents).length > 0) out[threadId] = agents;
  }
  return out;
}

function entryUrl(category: string, key: string, path: string[]): string {
  const entries = path.map((segment) => encodeURIComponent(segment)).join('/');
  return getApiUrl(`/settings/${category}/${key}/entries/${entries}`);
}

export const settingsApi = {
  /** List every override row (no defaults — only persisted overrides). */
  async list(): Promise<SettingsOverrideRecord[]> {
    return fetchData<SettingsOverrideRecord[]>(getApiUrl('/settings'));
  },

  /**
   * Every registered setting with `current` (override or default),
   * `default`, `isOverridden`, `valueType`, and override metadata. This
   * is the canonical read for any UI that wants the resolved value.
   */
  async registry(): Promise<SettingsRegistryRecord[]> {
    return fetchData<SettingsRegistryRecord[]>(getApiUrl('/settings/registry'));
  },

  /** One setting: its saved override as stored, else the default (`isOverridden` says which). */
  async get(category: string, key: string): Promise<SettingsValueRecord> {
    return fetchData<SettingsValueRecord>(getApiUrl(`/settings/${category}/${key}`));
  },

  /** Replace the value. Body is a real JSON value — no double-stringify. */
  async put<T>(category: string, key: string, value: T): Promise<void> {
    await fetchJson(getApiUrl(`/settings/${category}/${key}`), {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  },

  /** Shallow-merge partial fields into an object-shaped setting. */
  async patch<T extends object>(category: string, key: string, partial: Partial<T>): Promise<void> {
    await fetchJson(getApiUrl(`/settings/${category}/${key}`), {
      method: 'PATCH',
      body: JSON.stringify({ value: partial }),
    });
  },

  /**
   * Set one entry of a map-valued setting (e.g. one agent's override) without
   * sending the rest of the map, so saves from other windows survive. Returns
   * the server's resulting map.
   */
  async putEntry(category: string, key: string, path: string[], value: unknown): Promise<unknown> {
    const result = await fetchData<{ value: unknown }>(entryUrl(category, key, path), {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    return result.value;
  },

  /** Remove one entry of a map-valued setting. Returns the resulting map. */
  async deleteEntry(category: string, key: string, path: string[]): Promise<unknown> {
    const result = await fetchData<{ value: unknown }>(entryUrl(category, key, path), {
      method: 'DELETE',
    });
    return result.value;
  },

  /** Revert to the registry default by removing the override row. */
  async revert(category: string, key: string): Promise<void> {
    await fetchJson(getApiUrl(`/settings/${category}/${key}`), {
      method: 'DELETE',
    });
  },
};
