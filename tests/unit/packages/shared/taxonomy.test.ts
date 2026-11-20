/**
 * Unit tests for the node-model taxonomy value lists. No DB.
 */

import { describe, it, expect } from '@jest/globals';
import { CONTAINER_CATEGORIES, isContainerCategory } from '@snaglet/shared/constants';

describe('taxonomy value lists', () => {
  it('exposes the exact allowed values (kept in lockstep with the DB CHECKs)', () => {
    expect([...CONTAINER_CATEGORIES]).toEqual(['project']);
  });

  it('does not accept the retired categories', () => {
    // No translation shim by design: a write using an old value fails
    // validation truthfully rather than being silently rewritten, so callers
    // learn the vocabulary changed instead of quietly getting something else.
    // `status` is not a category: a task is a table row, not a doc placed in a
    // status column.
    for (const retired of ['reference', 'log', 'status']) {
      expect(isContainerCategory(retired)).toBe(false);
      expect(CONTAINER_CATEGORIES as readonly string[]).not.toContain(retired);
    }
  });

  it('guards accept allowed values and reject everything else', () => {
    expect(isContainerCategory('project')).toBe(true);
    expect(isContainerCategory('bogus')).toBe(false);
    expect(isContainerCategory(null)).toBe(false);
  });
});
