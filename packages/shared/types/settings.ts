/**
 * Wire shapes for the /api/settings endpoints.
 *
 * Server is the source of truth for setting types via the registry
 * (apps/server/src/services/settings). These types describe what the
 * REST endpoints emit; the UI imports them to render settings forms.
 */

export type SettingsValueType = 'boolean' | 'number' | 'string' | 'object' | 'array' | 'unknown';

/**
 * A row from `public.settings` — only present when the user has overridden
 * the registry default. Used by `GET /api/settings`.
 */
export interface SettingsOverrideRecord {
  category: string;
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: { kind: 'user'; id: string } | { kind: 'agent'; id: string } | null;
}

/**
 * A single setting from the registry — every declared setting, whether or
 * not the user has overridden it. Used by `GET /api/settings/registry`.
 *
 * `current` is either the override (when `isOverridden`) or `default`.
 * `valueType` is inferred from the default and is enough to render simple
 * forms; subtask 12 may add a full JSON-Schema field if generic auto-render
 * forms grow beyond what the default shape alone can support.
 */
export interface SettingsRegistryRecord {
  category: string;
  key: string;
  description: string;
  valueType: SettingsValueType;
  default: unknown;
  current: unknown;
  isOverridden: boolean;
  updatedAt: string | null;
  updatedBy: { kind: 'user'; id: string } | { kind: 'agent'; id: string } | null;
}

/**
 * One setting as `GET /api/settings/:category/:key` returns it: the stored
 * override as saved, else the registry default.
 */
export interface SettingsValueRecord {
  category: string;
  key: string;
  value: unknown;
  isOverridden: boolean;
}

/** PUT / PATCH body. */
export interface SettingsWriteBody {
  value: unknown;
}

/**
 * Realtime: after any setting is written or reverted, by any path (the
 * settings routes, an agent tool, a server job), the server sends
 * `settings:changed` ({@link SETTINGS_CHANGED_EVENT}) on the `settings`
 * channel ({@link SETTINGS_EVENT_CHANNEL}) with which setting changed. The
 * value is not in the frame: clients re-read the setting over REST.
 */
export const SETTINGS_EVENT_CHANNEL = 'settings' as const;
export const SETTINGS_CHANGED_EVENT = 'settings:changed' as const;
export interface SettingsChangedEvent {
  category: string;
  key: string;
}
