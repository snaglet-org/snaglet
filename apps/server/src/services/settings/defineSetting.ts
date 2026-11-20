/**
 * defineSetting / defineCategory — typed registration helpers for system
 * settings.
 *
 * Each setting is declared once: a category, a key path within the category,
 * a zod schema, a default value, and a description. The factory validates
 * the default against the schema at module load — a typo in a default
 * crashes the server at boot rather than misbehaving in production.
 *
 * Categories are the natural unit. A category file imports `defineCategory`,
 * declares its settings as a plain map, and exports the inflated object.
 * `defineCategory` also registers each setting into the global registry
 * (see ./registry.ts).
 */

import type { z } from 'zod';
import { registry } from './registry';

/**
 * A fully-resolved setting definition. `category` is set by `defineCategory`
 * for the consumer-facing shape; consumers don't write `category` directly
 * when calling `defineCategory`.
 */
export interface SettingDef<T = unknown> {
  category: string;
  /** Dotted key path within the category (e.g. 'preferences', 'node.doc.settings'). */
  key: string;
  /** Read-only fallback for a renamed key; writes always use `key`. */
  legacyKey?: string;
  schema: z.ZodType<T>;
  default: T;
  description: string;
  /**
   * For a map whose missing entries mean "use the default" (the color theme):
   * a `null` in a merge (`PATCH`, `settingsService.mergeEntries`) removes that
   * entry instead of storing null, so a reset follows later default changes
   * rather than pinning today's. Off unless set: other maps store null on
   * purpose (a budget's `maxWaves: null` means "no cap").
   */
  nullRemovesEntry?: boolean;
  /**
   * For a map setting: the stored value in today's shape (renamed keys carried
   * over to their successors, retired ones dropped). Every map write runs it
   * before changing the map, so a merge or removal by today's key names also
   * reaches entries saved under old ones.
   */
  normalize?: (value: Record<string, unknown>) => Record<string, unknown>;
  /** For a map setting: the only top-level keys a write may name; others are refused. */
  entryKeys?: readonly string[];
}

/**
 * The shape callers pass to `defineCategory` — same as `SettingDef` but
 * without `category` (the wrapping `defineCategory` call provides that).
 */
export type SettingInput<T> = Omit<SettingDef<T>, 'category'>;

/**
 * Type helper: given the input map passed to `defineCategory`, infer the
 * output map where every value is a fully-resolved `SettingDef<T>` with the
 * caller's `T` preserved through the schema.
 */
export type CategoryDefs<R> = {
  [K in keyof R]: R[K] extends SettingInput<infer T> ? SettingDef<T> : never;
};

/**
 * Declare a category of settings. Validates each default against its
 * schema, registers each into the global registry, and returns the
 * inflated map with `category` set on every entry. Throws synchronously
 * if any default fails its schema — caught at module load.
 *
 * Duplicate (category, key) across the whole registry also throws.
 */
export function defineCategory<R extends Record<string, SettingInput<unknown>>>(
  category: string,
  defs: R
): CategoryDefs<R> {
  if (!/^[a-z][a-z0-9_]*$/.test(category)) {
    throw new Error(
      `defineCategory: invalid category name "${category}" — must match /^[a-z][a-z0-9_]*$/`
    );
  }

  const out = {} as Record<string, SettingDef<unknown>>;
  for (const [name, input] of Object.entries(defs)) {
    const def: SettingDef<unknown> = { ...input, category };

    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(def.key)) {
      throw new Error(
        `defineSetting(${category}.${def.key}): invalid key — must match /^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*$/`
      );
    }

    const parsed = def.schema.safeParse(def.default);
    if (!parsed.success) {
      throw new Error(
        `defineSetting(${category}.${def.key}): default fails its own schema — ${parsed.error.message}`
      );
    }

    registry.register(def);
    out[name] = def;
  }
  return out as CategoryDefs<R>;
}

/**
 * Standalone setting declaration. Most callers use `defineCategory`; this
 * exists for one-off settings that don't naturally fit a category file.
 */
export function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.category)) {
    throw new Error(`defineSetting: invalid category "${def.category}"`);
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(def.key)) {
    throw new Error(`defineSetting: invalid key "${def.key}"`);
  }
  const parsed = def.schema.safeParse(def.default);
  if (!parsed.success) {
    throw new Error(
      `defineSetting(${def.category}.${def.key}): default fails its own schema — ${parsed.error.message}`
    );
  }
  registry.register(def);
  return def;
}
