/**
 * Unit tests for defineSetting / defineCategory.
 *
 * No DB. Verifies that:
 *   - defaults are validated against their schema at registration time
 *   - bad category / key strings are rejected
 *   - the registry is populated and prevents duplicates
 *   - the returned object preserves the caller's TypeScript types
 */

import { beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { defineCategory, defineSetting } from '@server/services/settings/defineSetting';
import { registry } from '@server/services/settings/registry';

beforeEach(() => {
  registry.__clearForTests();
});

describe('defineCategory', () => {
  it('registers settings and sets the category on each entry', () => {
    const cat = defineCategory('test_a', {
      flag: {
        key: 'flag',
        schema: z.boolean(),
        default: false,
        description: 'a flag',
      },
    });
    expect(cat.flag.category).toBe('test_a');
    expect(cat.flag.key).toBe('flag');
    expect(registry.get('test_a', 'flag')).toBeDefined();
  });

  it('throws if a default fails the schema', () => {
    expect(() =>
      defineCategory('test_b', {
        size: {
          key: 'size',
          schema: z.number().positive(),
          default: -1,
          description: '',
        },
      })
    ).toThrow(/default fails its own schema/);
  });

  it('throws if the category name is invalid', () => {
    expect(() =>
      defineCategory('Test-Bad' as string, {
        x: { key: 'x', schema: z.number(), default: 1, description: '' },
      })
    ).toThrow(/invalid category/);
  });

  it('throws if a key contains a leading digit', () => {
    expect(() =>
      defineCategory('test_c', {
        bad: { key: '1bad', schema: z.number(), default: 1, description: '' },
      })
    ).toThrow(/invalid key/);
  });

  it('throws if a key has uppercase characters', () => {
    expect(() =>
      defineCategory('test_d', {
        bad: { key: 'BadKey', schema: z.number(), default: 1, description: '' },
      })
    ).toThrow(/invalid key/);
  });

  it('accepts dotted keys for hierarchical grouping', () => {
    const cat = defineCategory('test_e', {
      docSettings: {
        key: 'node.doc.settings',
        schema: z.object({ enabled: z.boolean() }),
        default: { enabled: true },
        description: '',
      },
    });
    expect(cat.docSettings.key).toBe('node.doc.settings');
  });

  it('throws on duplicate (category, key) registration', () => {
    defineCategory('test_f', {
      a: { key: 'shared', schema: z.number(), default: 1, description: '' },
    });
    expect(() =>
      defineCategory('test_f', {
        b: { key: 'shared', schema: z.number(), default: 2, description: '' },
      })
    ).toThrow(/duplicate registration/);
  });

  it('preserves nested object schema typing through the inflated def', () => {
    const Schema = z.object({ flag: z.boolean(), count: z.number() });
    const cat = defineCategory('test_g', {
      complex: {
        key: 'complex',
        schema: Schema,
        default: { flag: true, count: 5 },
        description: '',
      },
    });
    // Compile-time check: cat.complex.default should be { flag: boolean; count: number }
    const d = cat.complex.default;
    expect(d.flag).toBe(true);
    expect(d.count).toBe(5);
  });
});

describe('defineSetting (standalone)', () => {
  it('validates and registers a single setting', () => {
    const def = defineSetting({
      category: 'test_h',
      key: 'solo',
      schema: z.string().min(1),
      default: 'ok',
      description: '',
    });
    expect(def.category).toBe('test_h');
    expect(registry.get('test_h', 'solo')).toBeDefined();
  });

  it('throws on bad default just like defineCategory', () => {
    expect(() =>
      defineSetting({
        category: 'test_i',
        key: 'solo',
        schema: z.string().min(5),
        default: 'x',
        description: '',
      })
    ).toThrow(/default fails its own schema/);
  });
});
