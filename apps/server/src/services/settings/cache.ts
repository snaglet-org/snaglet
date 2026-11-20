/**
 * Process-local TTL cache for setting values.
 *
 * Entries live for 30s. Cross-process invalidation is not handled here. For the packaged single-user
 * desktop app, a 30s pull interval is enough unless settings begin changing
 * from multiple long-lived processes.
 *
 * Two levels of cache key:
 *   - per-setting:  `${category}.${key}`              → cached value
 *   - per-category: `__category:${category}`          → cached category map
 *
 * A write to one setting invalidates both that setting's key AND its
 * category-level cache entry, so the next `readCategory` hits the DB.
 */

const DEFAULT_TTL_MS = 30_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

class SettingsCache {
  private store = new Map<string, Entry<unknown>>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get<T>(cacheKey: string): T | undefined {
    const entry = this.store.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(cacheKey);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(cacheKey: string, value: T): void {
    this.store.set(cacheKey, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Invalidate one setting's cache plus its category-level cache.
   * Passing only `category` invalidates every entry under that category
   * and the category map. Passing neither clears everything.
   */
  invalidate(category?: string, key?: string): void {
    if (!category) {
      this.store.clear();
      return;
    }
    if (key) {
      this.store.delete(settingKey(category, key));
      this.store.delete(categoryKey(category));
      return;
    }
    // Whole-category invalidation
    this.store.delete(categoryKey(category));
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(`${category}.`)) this.store.delete(k);
    }
  }

  /** Test-only: clear without TTL effects. */
  __clearForTests(): void {
    this.store.clear();
  }
}

export function settingKey(category: string, key: string): string {
  return `${category}.${key}`;
}

export function categoryKey(category: string): string {
  return `__category:${category}`;
}

export const cache = new SettingsCache();
