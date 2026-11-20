/**
 * SettingsRegistry singleton + the production registry's self-consistency.
 * No DB. Functional tests run against a fresh registry (get/has/all/
 * byCategory); self-validation imports the settings barrel (which loads every
 * category file) and checks every default against its own schema, so a typo
 * in a new category fails here.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { registry } from '@server/services/settings/registry';
import { defineCategory } from '@server/services/settings/defineSetting';

describe('SettingsRegistry', () => {
  beforeEach(() => {
    registry.__clearForTests();
  });

  it('returns undefined for unknown keys', () => {
    expect(registry.get('nope', 'nope')).toBeUndefined();
    expect(registry.has('nope', 'nope')).toBe(false);
  });

  it('finds a registered setting by category + key', () => {
    defineCategory('reg_a', {
      x: { key: 'x', schema: z.number(), default: 1, description: '' },
    });
    expect(registry.get('reg_a', 'x')).toBeDefined();
    expect(registry.has('reg_a', 'x')).toBe(true);
  });

  it('lists all settings across categories', () => {
    defineCategory('reg_b', {
      x: { key: 'x', schema: z.number(), default: 1, description: '' },
    });
    defineCategory('reg_c', {
      y: { key: 'y', schema: z.string(), default: 'z', description: '' },
    });
    const all = registry.all();
    expect(all.length).toBe(2);
    expect(all.map((d) => `${d.category}.${d.key}`).sort()).toEqual(['reg_b.x', 'reg_c.y']);
  });

  it('filters by category', () => {
    defineCategory('reg_d', {
      a: { key: 'a', schema: z.number(), default: 1, description: '' },
      b: { key: 'b', schema: z.number(), default: 2, description: '' },
    });
    defineCategory('reg_e', {
      c: { key: 'c', schema: z.number(), default: 3, description: '' },
    });
    expect(
      registry
        .byCategory('reg_d')
        .map((d) => d.key)
        .sort()
    ).toEqual(['a', 'b']);
    expect(registry.byCategory('reg_e').map((d) => d.key)).toEqual(['c']);
    expect(registry.byCategory('nope')).toEqual([]);
  });
});

describe('SettingsRegistry — production self-validation', () => {
  it('every registered default validates against its own schema', async () => {
    // Reload the side-effect barrel. Note: jest module cache means this
    // pulls the same registry instance the other tests touched — clear it
    // first, then re-import the barrel so category files re-register.
    registry.__clearForTests();
    jest.resetModules();
    await import('@server/services/settings');
    for (const def of registry.all()) {
      const parsed = def.schema.safeParse(def.default);
      expect(parsed.success).toBe(true);
    }
  });
});
