/**
 * SettingsRegistry — process-wide map of every declared SettingDef.
 *
 * Singleton populated by side-effect when category files import
 * `defineCategory` / `defineSetting`. Looking up a setting that hasn't
 * been registered yet returns undefined — callers should always go
 * through a typed SettingDef reference rather than guessing by string.
 *
 * Duplicate registration throws — catches the case where two category
 * files accidentally claim the same (category, key) pair.
 */

import type { SettingDef } from './defineSetting';

class SettingsRegistry {
  private byKey = new Map<string, SettingDef<unknown>>();

  register(def: SettingDef<unknown>): void {
    const composite = `${def.category}.${def.key}`;
    if (this.byKey.has(composite)) {
      throw new Error(`SettingsRegistry: duplicate registration for ${composite}`);
    }
    this.byKey.set(composite, def);
  }

  get(category: string, key: string): SettingDef<unknown> | undefined {
    return this.byKey.get(`${category}.${key}`);
  }

  has(category: string, key: string): boolean {
    return this.byKey.has(`${category}.${key}`);
  }

  all(): SettingDef<unknown>[] {
    return [...this.byKey.values()];
  }

  byCategory(category: string): SettingDef<unknown>[] {
    return this.all().filter((d) => d.category === category);
  }

  /** Test-only: reset the registry between test cases. */
  __clearForTests(): void {
    this.byKey.clear();
  }
}

export const registry = new SettingsRegistry();
