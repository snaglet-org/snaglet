import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_SEARCH_KINDS,
  DEFAULT_SEMANTIC_SEARCH_KINDS,
  SEARCHABLE_KINDS,
  SEMANTIC_SEARCH_KINDS,
} from '@server/services/ToolService/handlers/search/workspaceSearch/types';

/**
 * The file re-laning invariant: `file` leaves the default kind sets (so it never
 * floods the shared pool) but stays in the capability / searchable sets (so an
 * explicit `kinds: ['file']` — semantic or lexical — keeps working end-to-end).
 */
describe('search kind sets — files leave the defaults, not the capability', () => {
  it('excludes file from the default lexical + semantic kinds', () => {
    expect([...DEFAULT_SEARCH_KINDS]).not.toContain('file');
    expect([...DEFAULT_SEMANTIC_SEARCH_KINDS]).not.toContain('file');
  });

  it('keeps file explicitly searchable (validity sets)', () => {
    expect([...SEARCHABLE_KINDS]).toContain('file');
    expect(SEMANTIC_SEARCH_KINDS.has('file')).toBe(true);
  });

  it('SEARCHABLE_KINDS is exactly the defaults plus file', () => {
    expect(new Set(SEARCHABLE_KINDS)).toEqual(new Set([...DEFAULT_SEARCH_KINDS, 'file']));
  });
});

describe('search kind sets — structural lookup stays lexical', () => {
  it('does not advertise thread or container semantic lanes', () => {
    expect((SEMANTIC_SEARCH_KINDS as ReadonlySet<string>).has('thread')).toBe(false);
    expect((SEMANTIC_SEARCH_KINDS as ReadonlySet<string>).has('container')).toBe(false);
    expect([...DEFAULT_SEMANTIC_SEARCH_KINDS]).not.toContain('thread');
    expect([...DEFAULT_SEMANTIC_SEARCH_KINDS]).not.toContain('container');
  });

  it('preserves per-agent thread summaries as a semantic kind', () => {
    expect(SEMANTIC_SEARCH_KINDS.has('thread_summary')).toBe(true);
    expect([...DEFAULT_SEMANTIC_SEARCH_KINDS]).toContain('thread_summary');
  });
});
