/**
 * settingsService — typed read/write API for system settings.
 *
 * Callers pass a
 * `SettingDef` (from a registered category file); the service handles
 * cache lookup, DB fetch, schema validation, and default fallback.
 *
 * `read(def)` returns the schema-parsed value (override or default).
 * `readOptional(def)` returns null when no override exists — for
 *   settings like `search.table_semantic_default_on` where "not yet set" is
 *   a meaningful state distinct from "use the default."
 * `write(def, value, actor?)` validates, persists, invalidates cache,
 *   and emits a `settings:changed` event.
 * `revert(def)` removes the override (next read returns the default).
 * `writeEntry(def, path, entry)` / `removeEntry(def, path)` change one entry
 *   of a map-shaped setting under a row lock, leaving the others alone;
 *   `mergeEntries(def, partial)` sets several top-level entries the same way
 *   (and removes the ones given as null when the setting opts in with
 *   `nullRemovesEntry`).
 * `readCategory(category)` returns the full category as a map.
 * `onChange(handler)` subscribes to changes (process-local). The settings
 *   realtime surface (realtime/surfaces/settings.ts) forwards each one to
 *   desktop windows as `settings:changed`.
 *
 * Cross-process invalidation (e.g. the Tauri shell) is not implemented.
 * Single-user desktop flows tolerate the 30s pull cache.
 */

import { EventEmitter } from 'events';
import { transaction } from '@snaglet/db';
import { Settings, type SettingsWriteActor } from '@snaglet/db/tables/settings';
import { isRecord } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import type { SettingDef } from './defineSetting';
import { registry } from './registry';
import { cache, settingKey, categoryKey } from './cache';

/**
 * Entry keys that would reach `Object.prototype` instead of becoming an own
 * property of the parsed JSON map.
 */
const FORBIDDEN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** An entry path or a map shape that `writeEntry` / `removeEntry` refuses. */
export class SettingsEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsEntryError';
  }
}

function assertEntryPath(path: readonly string[]): void {
  if (path.length === 0) throw new SettingsEntryError('An entry path needs at least one key');
  for (const segment of path) {
    if (!segment || segment.length > 256 || FORBIDDEN_ENTRY_KEYS.has(segment)) {
      throw new SettingsEntryError(`Invalid entry key '${segment.slice(0, 64)}'`);
    }
  }
}

/** Refuse top-level keys a setting with `entryKeys` does not hold (the color theme's tokens). */
function assertKnownEntries(def: SettingDef<unknown>, keys: readonly string[]): void {
  const known = def.entryKeys;
  if (!known) return;
  const unknown = keys.filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  throw new SettingsEntryError(
    `Unknown ${unknown.length === 1 ? 'entry' : 'entries'} for ${def.category}.${def.key}: ` +
      `${unknown.join(', ')}. Valid entries: ${known.join(', ')}.`
  );
}

/** Set (`entry` defined) or remove one entry of a map-shaped value, in place. */
function applyEntry(
  root: Record<string, unknown>,
  path: readonly string[],
  entry: unknown
): boolean {
  const parents: Array<Record<string, unknown>> = [root];
  let node = root;
  for (const segment of path.slice(0, -1)) {
    const child = node[segment];
    if (child === undefined) {
      if (entry === undefined) return false;
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    } else if (isRecord(child)) {
      node = child;
    } else {
      throw new SettingsEntryError(`'${segment}' is not a map`);
    }
    parents.push(node);
  }
  const leaf = path[path.length - 1] as string;
  if (entry !== undefined) {
    node[leaf] = entry;
    return true;
  }
  if (!(leaf in node)) return false;
  delete node[leaf];
  // Drop maps the removal emptied (never the root itself).
  for (let depth = parents.length - 1; depth > 0; depth--) {
    const map = parents[depth] as Record<string, unknown>;
    if (Object.keys(map).length > 0) break;
    delete (parents[depth - 1] as Record<string, unknown>)[path[depth - 1] as string];
  }
  return true;
}

export interface SettingsChangeEvent {
  category: string;
  key: string;
  /** The new value (typed as unknown at the event surface; subscribers narrow). */
  value: unknown;
  /** True when the change deleted the override (reverted to default). */
  reverted: boolean;
  actor: SettingsWriteActor;
}

/** Select the canonical override first, including when its value is empty. */
export function selectSettingOverride<T>(
  def: SettingDef<unknown>,
  rows: ReadonlyMap<string, T>
): T | undefined {
  return rows.has(def.key)
    ? rows.get(def.key)
    : def.legacyKey
      ? rows.get(def.legacyKey)
      : undefined;
}

class SettingsService {
  private emitter = new EventEmitter();

  /**
   * Read a setting. Cache → DB row (schema-validated) → registry default.
   *
   * Throws if a persisted row exists but fails schema validation. A
   * corrupt override is a real bug — better to surface than silently
   * fall back to the default and mask it.
   */
  async read<T>(def: SettingDef<T>): Promise<T> {
    const ck = settingKey(def.category, def.key);
    const cached = cache.get<T>(ck);
    if (cached !== undefined) return cached;

    const row =
      (await Settings.read(def.category, def.key)) ??
      (def.legacyKey ? await Settings.read(def.category, def.legacyKey) : null);
    if (!row) {
      cache.set(ck, def.default);
      return def.default;
    }

    const parsed = def.schema.safeParse(row.value);
    if (!parsed.success) {
      throw new Error(
        `settingsService.read(${def.category}.${def.key}): persisted value fails schema — ${parsed.error.message}`
      );
    }
    cache.set(ck, parsed.data);
    return parsed.data;
  }

  /**
   * Variant of `read` that returns `null` when no override exists. Use
   * for settings where "unset" is a meaningful state distinct from
   * "use the default" (e.g. `search.table_semantic_default_on`).
   */
  async readOptional<T>(def: SettingDef<T>): Promise<T | null> {
    const row =
      (await Settings.read(def.category, def.key)) ??
      (def.legacyKey ? await Settings.read(def.category, def.legacyKey) : null);
    if (!row) return null;

    const parsed = def.schema.safeParse(row.value);
    if (!parsed.success) {
      throw new Error(
        `settingsService.readOptional(${def.category}.${def.key}): persisted value fails schema — ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  /**
   * Read every setting in a category as a `{ key → value }` map.
   * Settings without an override fall back to their registry default.
   * Settings present in the DB but not in the registry are surfaced
   * with a warning — likely stale rows from a removed setting.
   */
  async readCategory(category: string): Promise<Record<string, unknown>> {
    const ck = categoryKey(category);
    const cached = cache.get<Record<string, unknown>>(ck);
    if (cached !== undefined) return cached;

    const defs = registry.byCategory(category);
    const rows = await Settings.listByCategory(category);
    const rowByKey = new Map(rows.map((r) => [r.key, r.value] as const));

    const out: Record<string, unknown> = {};

    for (const def of defs) {
      const raw = selectSettingOverride(def, rowByKey);
      if (raw === undefined) {
        out[def.key] = def.default;
        continue;
      }
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `settingsService.readCategory(${category}.${def.key}): persisted value fails schema — ${parsed.error.message}`
        );
      }
      out[def.key] = parsed.data;
    }

    // Surface any DB rows that don't have a registry entry. These are
    // probably leftovers from a setting that was removed — log + include
    // them raw so they don't silently vanish.
    for (const row of rows) {
      if (!registry.has(category, row.key) && !defs.some((def) => def.legacyKey === row.key)) {
        logger.warn(`[settings] orphan row ${category}.${row.key} (no registry entry)`);
        out[row.key] = row.value;
      }
    }

    cache.set(ck, out);
    return out;
  }

  /**
   * Validate, persist, invalidate cache, emit event. Throws if value
   * fails the schema. `actor` defaults to no-author (legitimate for
   * migration / boot writes).
   */
  async write<T>(def: SettingDef<T>, value: T, actor: SettingsWriteActor = {}): Promise<T> {
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `settingsService.write(${def.category}.${def.key}): value fails schema — ${parsed.error.message}`
      );
    }

    await Settings.write(def.category, def.key, parsed.data, actor);
    cache.invalidate(def.category, def.key);

    this.emitter.emit('settings:changed', {
      category: def.category,
      key: def.key,
      value: parsed.data,
      reverted: false,
      actor,
    } satisfies SettingsChangeEvent);

    return parsed.data;
  }

  /**
   * Remove the override. The registry default takes effect on the next
   * read. Returns the default for caller convenience.
   */
  async revert<T>(def: SettingDef<T>, actor: SettingsWriteActor = {}): Promise<T> {
    // Clear the fallback too, so reverting cannot resurrect an old override.
    if (def.legacyKey) await Settings.remove(def.category, def.legacyKey);
    await Settings.remove(def.category, def.key);
    cache.invalidate(def.category, def.key);

    this.emitter.emit('settings:changed', {
      category: def.category,
      key: def.key,
      value: def.default,
      reverted: true,
      actor,
    } satisfies SettingsChangeEvent);

    return def.default;
  }

  /**
   * Set one entry of a map-shaped setting (e.g. one agent's summary-model
   * override) without rewriting the others. The read-modify-write runs in one
   * transaction on a locked row, so two windows saving different entries
   * cannot overwrite each other. The whole result is schema-validated.
   * Returns the new full value.
   */
  async writeEntry<T>(
    def: SettingDef<T>,
    path: readonly string[],
    entry: unknown,
    actor: SettingsWriteActor = {}
  ): Promise<T> {
    if (entry === undefined) throw new SettingsEntryError('An entry value is required');
    return this.mutateEntry(def, path, entry, actor);
  }

  /**
   * Remove one entry of a map-shaped setting, dropping any parent map the
   * removal leaves empty. Idempotent. Returns the new full value.
   */
  async removeEntry<T>(
    def: SettingDef<T>,
    path: readonly string[],
    actor: SettingsWriteActor = {}
  ): Promise<T> {
    return this.mutateEntry(def, path, undefined, actor);
  }

  /**
   * Shallow-merge `partial` into a map-shaped setting (`PATCH`, the Theme
   * view's save and resets, `change_color_theme`): the given keys replace
   * theirs, the rest stay. When the setting opts in with `nullRemovesEntry`, a
   * null value removes its key instead (JSON Merge Patch). Only a merge that
   * sets something creates the row. Runs on the locked row like `writeEntry`,
   * so two writers merging different keys at once both keep theirs. The whole
   * result is schema-validated. Returns the new full value.
   */
  async mergeEntries<T>(
    def: SettingDef<T>,
    partial: Record<string, unknown>,
    actor: SettingsWriteActor = {}
  ): Promise<T> {
    for (const key of Object.keys(partial)) assertEntryPath([key]);
    assertKnownEntries(def, Object.keys(partial));
    const removes = (value: unknown) => value === null && def.nullRemovesEntry === true;
    const create = Object.values(partial).some((value) => !removes(value));
    return this.updateMapLocked(def, actor, 'mergeEntries', create, (root) => {
      const before = JSON.stringify(root);
      for (const [key, value] of Object.entries(partial)) {
        if (removes(value)) delete root[key];
        else root[key] = value;
      }
      return JSON.stringify(root) !== before;
    });
  }

  private async mutateEntry<T>(
    def: SettingDef<T>,
    path: readonly string[],
    entry: unknown,
    actor: SettingsWriteActor
  ): Promise<T> {
    assertEntryPath(path);
    assertKnownEntries(def, path.slice(0, 1));
    return this.updateMapLocked(
      def,
      actor,
      entry === undefined ? 'removeEntry' : 'writeEntry',
      entry !== undefined,
      (root) => applyEntry(root, path, entry)
    );
  }

  /**
   * Read-modify-write a map-shaped setting in one transaction on its locked
   * row. `create` makes the row (from the default) when there is none yet;
   * `change` edits the map in place and says whether it changed anything. A
   * setting's `normalize` runs on the stored map first, and a map it reshapes
   * is written back even when `change` alone changed nothing.
   */
  private async updateMapLocked<T>(
    def: SettingDef<T>,
    actor: SettingsWriteActor,
    operation: string,
    create: boolean,
    change: (root: Record<string, unknown>) => boolean
  ): Promise<T> {
    if (!isRecord(def.default)) {
      throw new SettingsEntryError(`${def.category}.${def.key} is not a map-shaped setting`);
    }
    const fallback = def.legacyKey ? await this.readOptional(def) : null;
    const params = [def.category, def.key] as const;
    // Inline SQL: the Settings model is not transaction-aware, and the lock
    // is what makes concurrent map writes safe.
    const result = await transaction(async (tx) => {
      if (create || fallback !== null) {
        await tx.query(
          `INSERT INTO public.settings (category, key, value, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (category, key) DO NOTHING`,
          [...params, JSON.stringify(fallback ?? def.default)]
        );
      }
      const { rows } = await tx.query<{ value: unknown }>(
        `SELECT value FROM public.settings WHERE category = $1 AND key = $2 FOR UPDATE`,
        [...params]
      );
      const row = rows[0];
      if (!row) return { value: def.default, changed: false };
      if (!isRecord(row.value)) {
        throw new SettingsEntryError(`${def.category}.${def.key} does not hold a map`);
      }
      const stored = structuredClone(row.value);
      const root = def.normalize ? def.normalize(stored) : stored;
      const reshaped = JSON.stringify(root) !== JSON.stringify(stored);
      const changed = change(root) || reshaped;
      const parsed = def.schema.safeParse(root);
      if (!parsed.success) {
        throw new Error(
          `settingsService.${operation}(${def.category}.${def.key}): value fails schema — ${parsed.error.message}`
        );
      }
      if (changed) {
        await tx.query(
          `UPDATE public.settings
              SET value = $3::jsonb, updated_at = now(),
                  updated_by_user_id = $4, updated_by_agent_id = $5
            WHERE category = $1 AND key = $2`,
          [...params, JSON.stringify(parsed.data), actor.userId ?? null, actor.agentId ?? null]
        );
      }
      return { value: parsed.data, changed };
    });

    cache.invalidate(def.category, def.key);
    if (result.changed) {
      this.emitter.emit('settings:changed', {
        category: def.category,
        key: def.key,
        value: result.value,
        reverted: false,
        actor,
      } satisfies SettingsChangeEvent);
    }
    return result.value;
  }

  /** Subscribe to setting changes. Returns an unsubscribe function. */
  onChange(handler: (e: SettingsChangeEvent) => void): () => void {
    this.emitter.on('settings:changed', handler);
    return () => this.emitter.off('settings:changed', handler);
  }

  /** Force-clear the cache. Optional `category` + `key` narrow the scope. */
  invalidate(category?: string, key?: string): void {
    cache.invalidate(category, key);
  }
}

export const settingsService = new SettingsService();
