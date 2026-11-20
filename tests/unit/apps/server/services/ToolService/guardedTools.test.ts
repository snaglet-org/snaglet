/**
 * guardedTools — the guarded-set derivation and the creation-time
 * confirmation default.
 *
 * The guarded set must be derived, never hand-maintained: the call-time
 * permission kinds (GUARDED_TOOL_KINDS, shared with the UI) plus every
 * builtin definition flagged `destructive: true` in the registry. These tests
 * drive the derivation against a controlled registry and pin the merge
 * semantics used at agent creation (explicit caller values always win).
 */

const loadMock = jest.fn();
const getAllDefinitionsMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: (...args: unknown[]) => loadMock(...args),
    getAllDefinitions: (...args: unknown[]) => getAllDefinitionsMock(...args),
  },
}));

import {
  getGuardedToolIds,
  withGuardedConfirmationDefaults,
} from '@server/services/ToolService/lib/guardedTools';
import { GUARDED_TOOL_KINDS } from '@snaglet/shared/utils';

beforeEach(() => {
  jest.clearAllMocks();
  loadMock.mockResolvedValue(undefined);
  getAllDefinitionsMock.mockReturnValue({
    delete_doc: { id: 'delete_doc', destructive: true },
    thread_delete: { id: 'thread_delete', destructive: true },
    file_read: { id: 'file_read' },
    // guarded-by-kind and destructive — must appear exactly once
    database_execute: { id: 'database_execute', destructive: true },
    // merged op tool, destructive on one op only
    merged_thread: { id: 'merged_thread', destructiveOps: ['delete'] },
    empty_ops: { id: 'empty_ops', destructiveOps: [] },
  });
});

describe('getGuardedToolIds', () => {
  it('is the union of the shared call-time-guarded kinds and destructive definitions', async () => {
    const ids = await getGuardedToolIds();

    // every call-time-guarded kind (shell/file/SQL/git) is present
    for (const kindId of Object.keys(GUARDED_TOOL_KINDS)) {
      expect(ids).toContain(kindId);
    }
    // every destructive definition rides in
    expect(ids).toContain('delete_doc');
    expect(ids).toContain('thread_delete');
    // a merged tool with destructiveOps is guarded (resolver narrows it per op)
    expect(ids).toContain('merged_thread');
    // non-destructive, non-guarded tools stay out
    expect(ids).not.toContain('file_read');
    expect(ids).not.toContain('empty_ops');
    // no duplicates for tools in both halves
    expect(ids.filter((id) => id === 'database_execute')).toHaveLength(1);
  });

  it('degrades to the static guarded kinds when the registry fails to load', async () => {
    loadMock.mockRejectedValue(new Error('registry exploded'));

    const ids = await getGuardedToolIds();

    expect(ids).toEqual([...Object.keys(GUARDED_TOOL_KINDS)].sort());
  });
});

describe('withGuardedConfirmationDefaults', () => {
  it('sets requiresConfirmation: true for every guarded tool on an empty input', async () => {
    const overrides = await withGuardedConfirmationDefaults(null);

    for (const id of await getGuardedToolIds()) {
      expect(overrides[id]).toEqual({ requiresConfirmation: true });
    }
  });

  it('preserves explicit caller values (true or false) and per-tool settings', async () => {
    const overrides = await withGuardedConfirmationDefaults({
      shell_exec: { requiresConfirmation: false },
      file_write: { settings: { rootDir: '/proj' } },
      web_search: { settings: { maxResults: 3 } },
    });

    // explicit false is respected — the default never overwrites a decision
    expect(overrides.shell_exec).toEqual({ requiresConfirmation: false });
    // settings survive alongside the added default
    expect(overrides.file_write).toEqual({
      settings: { rootDir: '/proj' },
      requiresConfirmation: true,
    });
    // non-guarded overrides pass through untouched
    expect(overrides.web_search).toEqual({ settings: { maxResults: 3 } });
  });

  it('never mutates the input map', async () => {
    const input = { shell_exec: { settings: { a: 1 } } };
    const snapshot = JSON.parse(JSON.stringify(input));

    await withGuardedConfirmationDefaults(input);

    expect(input).toEqual(snapshot);
  });
});
