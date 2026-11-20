/**
 * syncToolCatalog — the shared catalog reconciler's diffing, soft-retire, and
 * write-back verification. A concurrent server from a stale checkout can
 * reverse the sync's writes (a retired tool re-enabled, a real row missing)
 * while the sync still reports success, so any divergence between the
 * intended set and the read-back state fails the report.
 */

import { describe, expect, it } from '@jest/globals';
import type { CreateToolInput, ToolRow } from '@snaglet/db';
import {
  syncToolCatalog,
  type ToolCatalogStore,
} from '@server/services/ToolService/lib/syncToolCatalog';

function makeRow(overrides: Partial<ToolRow> & { id: string }): ToolRow {
  return {
    name: overrides.id,
    description: '',
    type: 'builtin',
    parametersSchema: {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'standard',
    categoryPath: 'uncategorized',
    providerId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function def(id: string): CreateToolInput {
  return { id, name: id, type: 'builtin', enabled: true };
}

/**
 * In-memory store with faithful upsert semantics: insert stamps
 * enabled=input??true; conflict preserves the existing enabled flag (mirrors
 * ToolModel.upsertTool's ON CONFLICT, which intentionally omits `enabled`).
 */
class FakeStore implements ToolCatalogStore {
  rows = new Map<string, ToolRow>();
  listAllCalls = 0;
  /** Hook fired before the verification read (the second listAll). */
  onBeforeVerify: (() => void) | null = null;

  constructor(seed: ToolRow[] = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }

  async listAll(): Promise<ToolRow[]> {
    this.listAllCalls += 1;
    if (this.listAllCalls === 2 && this.onBeforeVerify) this.onBeforeVerify();
    return [...this.rows.values()];
  }

  async upsertTool(input: CreateToolInput): Promise<ToolRow> {
    const existing = this.rows.get(input.id);
    const row = makeRow({
      ...input,
      id: input.id,
      enabled: existing ? existing.enabled : (input.enabled ?? true),
    } as Partial<ToolRow> & { id: string });
    this.rows.set(input.id, row);
    return row;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ToolRow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, enabled };
    this.rows.set(id, next);
    return next;
  }
}

describe('syncToolCatalog', () => {
  it('reports real adds/updates/retires derived from before/after state', async () => {
    const store = new FakeStore([
      makeRow({ id: 'existing_tool' }),
      makeRow({ id: 'ghost_tool' }), // enabled builtin, no folder → retire
    ]);

    const report = await syncToolCatalog([def('existing_tool'), def('brand_new_tool')], { store });

    expect(report.added).toEqual(['brand_new_tool']);
    expect(report.updated).toEqual(['existing_tool']);
    expect(report.retired).toEqual(['ghost_tool']);
    expect(report.retireSkipped).toBe(false);
    expect(report.ok).toBe(true);

    // Retire is soft: the row survives, disabled — never a delete.
    expect(store.rows.get('ghost_tool')).toBeDefined();
    expect(store.rows.get('ghost_tool')!.enabled).toBe(false);
    expect(store.rows.get('brand_new_tool')!.enabled).toBe(true);
  });

  it('skips the retire pass when the tree exposes <50% of enabled builtins', async () => {
    const store = new FakeStore([makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })]);

    const report = await syncToolCatalog([def('a')], { store });

    expect(report.retireSkipped).toBe(true);
    expect(report.retireSkipReason).toMatch(/partial checkout/);
    expect(report.retired).toEqual([]);
    // Upserts still ran.
    expect(report.updated).toEqual(['a']);
    // Nothing was disabled.
    expect(store.rows.get('b')!.enabled).toBe(true);
    expect(store.rows.get('c')!.enabled).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('skips the retire pass when the caller disallows it (incomplete load)', async () => {
    const store = new FakeStore([makeRow({ id: 'a' }), makeRow({ id: 'stale' })]);

    const report = await syncToolCatalog([def('a')], {
      store,
      allowRetire: false,
      retireDisallowedReason: 'incomplete load (1/2)',
    });

    expect(report.retireSkipped).toBe(true);
    expect(report.retireSkipReason).toBe('incomplete load (1/2)');
    expect(store.rows.get('stale')!.enabled).toBe(true);
  });

  it('fails verification when a retire does not stick (lying setEnabled)', async () => {
    const store = new FakeStore([makeRow({ id: 'a' }), makeRow({ id: 'ghost_tool' })]);
    store.setEnabled = async (id) => store.rows.get(id) ?? null; // silent no-op

    const report = await syncToolCatalog([def('a')], { store });

    expect(report.retired).toEqual(['ghost_tool']);
    expect(report.ok).toBe(false);
    expect(report.divergence.join('\n')).toMatch(/ghost_tool.*reads back enabled/);
  });

  it('fails verification when an upsert silently writes nothing', async () => {
    const store = new FakeStore([makeRow({ id: 'a' })]);
    const realUpsert = store.upsertTool.bind(store);
    store.upsertTool = async (input) => {
      if (input.id === 'dropped_tool') return makeRow({ id: 'dropped_tool' }); // lies, writes nothing
      return realUpsert(input);
    };

    const report = await syncToolCatalog([def('a'), def('dropped_tool')], { store });

    expect(report.ok).toBe(false);
    expect(report.divergence.join('\n')).toMatch(/dropped_tool.*no row exists after sync/);
  });

  it('fails verification when a concurrent writer resurrects a ghost mid-window', async () => {
    // Another checkout's server boots between this sync's writes and its
    // verification read, re-inserting an enabled builtin that has no folder
    // in this tree.
    const store = new FakeStore([makeRow({ id: 'a' })]);
    store.onBeforeVerify = () => {
      store.rows.set('resurrected_ghost', makeRow({ id: 'resurrected_ghost' }));
    };

    const report = await syncToolCatalog([def('a')], { store });

    expect(report.ok).toBe(false);
    expect(report.divergence.join('\n')).toMatch(
      /resurrected_ghost.*enabled builtin row with no tool folder/
    );
  });

  it('fails verification when a fresh insert reads back disabled', async () => {
    const store = new FakeStore();
    const realUpsert = store.upsertTool.bind(store);
    store.upsertTool = async (input) => {
      const row = await realUpsert(input);
      const broken = { ...row, enabled: false };
      store.rows.set(input.id, broken);
      return row; // reports enabled=true, stored disabled
    };

    const report = await syncToolCatalog([def('new_tool')], { store });

    expect(report.ok).toBe(false);
    expect(report.divergence.join('\n')).toMatch(/new_tool.*reads back disabled/);
  });

  it('collects per-tool errors and refuses to retire on a failed sync', async () => {
    const store = new FakeStore([makeRow({ id: 'a' }), makeRow({ id: 'stale' })]);
    const realUpsert = store.upsertTool.bind(store);
    store.upsertTool = async (input) => {
      if (input.id === 'a') throw new Error('constraint violation');
      return realUpsert(input);
    };

    const report = await syncToolCatalog([def('a'), def('b')], { store });

    expect(report.errors.join('\n')).toMatch(/a: constraint violation/);
    expect(report.retireSkipped).toBe(true);
    expect(report.retireSkipReason).toMatch(/upsert error/);
    expect(store.rows.get('stale')!.enabled).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('rejects duplicate ids in the discovered set', async () => {
    const store = new FakeStore();
    const report = await syncToolCatalog([def('twin'), def('twin')], { store });
    expect(report.errors.join('\n')).toMatch(/duplicate tool id.*twin/);
    expect(report.ok).toBe(false);
  });

  it('rejects tool ids violating the provider function-name grammar', async () => {
    const store = new FakeStore();
    const report = await syncToolCatalog([def('bad id!')], { store });
    expect(report.errors.join('\n')).toMatch(/bad id!/);
    expect(report.ok).toBe(false);
    expect(store.rows.has('bad id!')).toBe(false);
  });
});
