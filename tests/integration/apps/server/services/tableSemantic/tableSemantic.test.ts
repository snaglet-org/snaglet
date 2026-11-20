/**
 * Vector search over table rows against a real database: on by default for a
 * new table, enabling and disabling, the background build and its
 * re-embedding rule, edits and deletes, the 10,000-row cap and the size
 * estimate, and a ranking comparison of keyword-only search against keyword +
 * meaning. The boot default for older tables is in tableSemanticDefaultOn.test.ts.
 *
 * The embedder is a small deterministic concept embedder (synonyms share an
 * axis), so "cat" lands near "feline" without any model files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb } from '@snaglet/db/db';
import { Containers } from '@snaglet/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableEntriesDeleted: jest.fn(),
}));
import {
  applyAgentSchema,
  deleteAgentEntries,
  writeAgentEntries,
} from '@server/domains/tables/tableAgent';
import {
  resetEmbeddingProvider,
  setEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import {
  backfillSemanticTable,
  buildSemanticIndex,
  classifySemanticEntries,
  embedSemanticEntryTarget,
  getSemanticStatus,
  listSemanticTables,
  setSemanticSearch,
  sweepTableEntries,
} from '@server/services/tableSemantic/TableSemanticService';
import { noteEntriesChanged, resetTable } from '@server/services/tableSemantic/sweepState';
import { searchPaletteEntries } from '@server/services/search/paletteEntrySearch';
import entrySearch from '@server/services/ToolService/handlers/search/entrySearch';

const CONCEPTS = [
  ['cat', 'cats', 'feline', 'kitten', 'kittens'],
  ['dog', 'dogs', 'canine', 'puppy'],
  ['invoice', 'billing', 'payment', 'payments', 'receipt'],
  ['meeting', 'standup', 'sync'],
];

/** 768 dimensions: one axis per concept, the rest a faint hash of the other words. */
function vectorFor(text: string): number[] {
  const vector = new Array<number>(768).fill(0);
  for (const word of text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)) {
    const axis = CONCEPTS.findIndex((group) => group.includes(word));
    if (axis >= 0) vector[axis]! += 1;
    else {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[16 + (hash % 700)]! += 0.05;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const embedDocument = jest.fn(async (text: string) => vectorFor(text));
const embedQuery = jest.fn(async (text: string) => vectorFor(text));
const provider: EmbeddingProvider = {
  info: { provider: 'test', model: 'concept-embedder', dimensions: 768 },
  embedDocument: (text) => embedDocument(text),
  embedQuery: (text) => embedQuery(text),
};

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' })) {
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
    resetTable(table.id);
  }
  await getDb().query('DELETE FROM public.table_semantic_search');
  await getDb().query('DELETE FROM public.table_entry_embeddings');
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.containers WHERE id = ANY($1::text[])', [PROJECTS]);
  await getDb().query(
    "DELETE FROM public.settings WHERE category = 'search' AND key = 'table_semantic_off'"
  );
}

const PROJECTS = ['container-4444444444444-projecta', 'container-4444444444444-projectb'];

const ID = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

const NOTES = [
  { id: ID(1), summary: 'Feline care guide', body: 'feeding and grooming' },
  { id: ID(2), summary: 'Kitten vaccination schedule', body: 'shots in the first year' },
  { id: ID(3), summary: 'Dog training basics', body: 'sit and stay' },
  { id: ID(4), summary: 'Quarterly invoice summary', body: 'totals by customer' },
  { id: ID(5), summary: 'Payment reminders', body: 'chase late billing' },
  { id: ID(6), summary: 'Team standup notes', body: 'weekly sync' },
];

async function seedNotes(): Promise<string> {
  const { table } = await applyAgentSchema('notes', {
    fields: [
      { name: 'summary', type: 'text' },
      { name: 'body', type: 'text' },
      { name: 'api_key', type: 'text' },
    ],
    ops: [{ op: 'set_title_field', name: 'summary' }],
  });
  await writeAgentEntries('notes', {
    insert: NOTES.map((note) => ({
      id: note.id,
      values: { summary: note.summary, body: note.body },
    })),
  });
  return table.id;
}

/** Add `count` rows (named "grown N") straight in SQL, as an import or a bulk write would. */
async function grow(tableId: string, count: number): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [tableId]
  );
  await getDb().query(
    `INSERT INTO user_tables.${quoteIdentifier(rows[0]!.table_name)} (id, name)
     SELECT gen_random_uuid(), 'grown ' || g FROM generate_series(1, $1::int) g`,
    [count]
  );
}

/** The `search.table_semantic_off` setting: tables a person turned off. */
async function turnedOff(): Promise<Record<string, string>> {
  const { rows } = await getDb().query<{ value: Record<string, string> }>(
    "SELECT value FROM public.settings WHERE category = 'search' AND key = 'table_semantic_off'"
  );
  return rows[0]?.value ?? {};
}

interface Result {
  entries: Array<{ id: string; title: string; match?: string; snippet?: string }>;
  semantic?: { tables: string[]; indexing: string[]; used: boolean; note?: string };
}

async function search(input: Record<string, unknown>): Promise<Result> {
  return JSON.parse(
    (await entrySearch({ kinds: ['entry'], table: 'notes', ...input }, {}, undefined)) as string
  ) as Result;
}

describe('vector search of table rows (real DB)', () => {
  beforeEach(async () => {
    await cleanup();
    setEmbeddingProvider(provider);
    embedDocument.mockClear();
  });
  afterEach(() => resetEmbeddingProvider());
  afterAll(cleanup);

  it('is on by default for a new table (no confirmation) and builds in the background', async () => {
    const tableId = await seedNotes();
    expect(await TableSemantic.getSettings(tableId)).toMatchObject({ confirmedRows: null });
    expect(await getSemanticStatus(tableId)).toMatchObject({
      enabled: true,
      state: 'indexing',
      indexed: 0,
      rows: 6,
      needsConfirmation: false,
    });
    expect(await buildSemanticIndex()).toBe(6);
    expect(await getSemanticStatus(tableId)).toMatchObject({ state: 'ready', indexed: 6 });
  });

  it('turned off, nothing is built', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: false });
    expect(await getSemanticStatus(tableId)).toMatchObject({
      enabled: false,
      state: 'off',
      indexed: 0,
      rows: 6,
    });
    expect(await sweepTableEntries()).toBe(0);
    expect(embedDocument).not.toHaveBeenCalled();
  });

  it('turning it on returns the size and builds one vector per row in the background', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: false });
    const on = await setSemanticSearch(tableId, { enabled: true });
    expect(on).toMatchObject({
      enabled: true,
      state: 'indexing',
      indexed: 0,
      rows: 6,
      needsConfirmation: false,
      estimate: { rows: 6, label: '~26 KB' },
    });
    expect(await buildSemanticIndex()).toBe(6);
    expect(await getSemanticStatus(tableId)).toMatchObject({ state: 'ready', indexed: 6 });
    expect(embedDocument).toHaveBeenCalledTimes(6);
    // One embedding per row: the card holds the table name, title and prose, never the API key.
    expect(embedDocument.mock.calls[0]![0]).toMatch(/^Table: notes\nTitle: /);
  });

  it('builds in steps while keyword search keeps working', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    expect(await sweepTableEntries({ embedBudget: 2 })).toBe(2);
    expect(await getSemanticStatus(tableId)).toMatchObject({ state: 'indexing', indexed: 2 });
    const reply = await search({ query: 'invoice', mode: 'keyword' });
    expect(reply.entries.map((entry) => entry.title)).toEqual(['Quarterly invoice summary']);
    const previous = process.env.SNAGLET_LOCAL_INTELLIGENCE;
    try {
      process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
      const hybrid = await search({ query: 'invoice' });
      expect(hybrid.semantic?.indexing).toEqual(['notes']);
      expect(hybrid.semantic?.note).toMatch(/Still building/);
      // With the background build off, the reply says the index is not being built.
      delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
      const paused = await search({ query: 'invoice' });
      expect(paused.semantic?.note).toMatch(
        /not being built: Automatic local intelligence is off.*Keyword results are complete/
      );
    } finally {
      if (previous === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
      else process.env.SNAGLET_LOCAL_INTELLIGENCE = previous;
    }
  });

  it('classifies precise fresh, stale, and missing targets and embeds them without worker state', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();

    let classified = await classifySemanticEntries();
    expect(classified).toMatchObject({ fresh: 6, stale: 0, missing: 0 });
    expect(classified.target).toHaveLength(0);

    await writeAgentEntries('notes', {
      update: [{ id: ID(1), values: { summary: 'Feline care and feeding guide' } }],
    });
    classified = await classifySemanticEntries();
    expect(classified).toMatchObject({ fresh: 5, stale: 1, missing: 0 });
    expect(classified.target).toEqual([
      expect.objectContaining({ tableId, entryId: ID(1), state: 'stale' }),
    ]);
    expect(await embedSemanticEntryTarget(classified.target[0]!)).toBe(true);

    await TableSemantic.deleteEntries(tableId, [ID(2)]);
    classified = await classifySemanticEntries();
    expect(classified).toMatchObject({ fresh: 5, stale: 0, missing: 1 });
    expect(classified.target).toEqual([
      expect.objectContaining({ tableId, entryId: ID(2), state: 'missing' }),
    ]);
    expect(await embedSemanticEntryTarget(classified.target[0]!)).toBe(true);
    expect(await classifySemanticEntries()).toMatchObject({ fresh: 6, stale: 0, missing: 0 });
  });

  it('does not resurrect a target when semantic search is disabled during embedding', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    await TableSemantic.deleteEntries(tableId, [ID(1)]);
    const target = (await classifySemanticEntries()).target.find((item) => item.entryId === ID(1));
    expect(target).toBeDefined();

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    embedDocument.mockImplementationOnce(async () => {
      await waiting;
      return vectorFor('late embedding');
    });
    const embedding = embedSemanticEntryTarget(target!);
    await Promise.resolve();
    await setSemanticSearch(tableId, { enabled: false });
    release();

    expect(await embedding).toBe(false);
    expect(await TableSemantic.hashes(tableId, [ID(1)])).toEqual(new Map());
  });

  it('re-embeds only a row whose card changed', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    embedDocument.mockClear();
    const before = await TableSemantic.hashes(tableId, [ID(1), ID(2)]);

    await writeAgentEntries('notes', {
      update: [{ id: ID(1), values: { summary: 'Feline care and feeding guide' } }],
    });
    // A secret cell is not on the card, so editing it changes nothing.
    await writeAgentEntries('notes', {
      update: [{ id: ID(2), values: { api_key: 'sk-live-1' } }],
    });
    noteEntriesChanged(tableId);
    await buildSemanticIndex();

    expect(embedDocument).toHaveBeenCalledTimes(1);
    expect(embedDocument.mock.calls[0]![0]).toContain('Feline care and feeding guide');
    const after = await TableSemantic.hashes(tableId, [ID(1), ID(2)]);
    expect(after.get(ID(1))).not.toBe(before.get(ID(1)));
    expect(after.get(ID(2))).toBe(before.get(ID(2)));
  });

  it('picks up an edit made to a row the build had already passed', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    // Build halfway: the first rows are done and the cursor sits after them.
    await sweepTableEntries({ embedBudget: 3 });
    await writeAgentEntries('notes', {
      update: [{ id: ID(1), values: { summary: 'Feline care and feeding guide' } }],
    });
    noteEntriesChanged(tableId); // what the entries-changed event does
    embedDocument.mockClear();
    await buildSemanticIndex();
    // The pass restarted instead of finishing: the edited row is re-embedded.
    expect(embedDocument.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'Feline care and feeding guide'
    );
    expect(await getSemanticStatus(tableId)).toMatchObject({ state: 'ready', indexed: 6 });
  });

  it("deletes a row's vector with the row, and sweeps up one deleted behind its back", async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    expect(await TableSemantic.indexedCount(tableId)).toBe(6);

    await deleteAgentEntries('notes', { ids: [ID(3)], clearLinks: false });
    expect([...(await TableSemantic.hashes(tableId, [ID(3)])).keys()]).toEqual([]);
    expect(await TableSemantic.indexedCount(tableId)).toBe(5);

    // A SQL delete tells nobody: the next full pass removes the orphan vector.
    const { rows } = await getDb().query<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [tableId]
    );
    await getDb().query(
      `DELETE FROM user_tables.${quoteIdentifier(rows[0]!.table_name)} WHERE id = $1`,
      [ID(4)]
    );
    resetTable(tableId);
    await buildSemanticIndex();
    expect(await TableSemantic.indexedCount(tableId)).toBe(4);
  });

  it('turning it off deletes the vectors and the setting, remembers the choice, and search is keyword-only again', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    const off = await setSemanticSearch(tableId, { enabled: false });
    expect(off).toMatchObject({ enabled: false, state: 'off', indexed: 0 });
    expect(await TableSemantic.indexedCount(tableId)).toBe(0);
    expect(await TableSemantic.getSettings(tableId)).toBeNull();
    expect(Object.keys(await turnedOff())).toEqual([tableId]);
    const reply = await search({ query: 'cat' });
    expect(reply.semantic).toBeUndefined();
    expect(reply.entries).toEqual([]);
  });

  it('holds a table that grows past the cap without a confirmation: what is built stays and still answers', async () => {
    const tableId = await seedNotes(); // on by default, 6 rows
    expect(await buildSemanticIndex()).toBe(6);
    await grow(tableId, 10_000);
    noteEntriesChanged(tableId); // what the entries-changed event does
    embedDocument.mockClear();

    expect(await sweepTableEntries()).toBe(0);
    expect(embedDocument).not.toHaveBeenCalled();
    expect(await buildSemanticIndex()).toBe(0); // a held table counts as done, so this ends
    expect(await getSemanticStatus(tableId)).toMatchObject({
      enabled: true,
      awaitingConfirm: true,
      state: 'indexing',
      indexed: 6,
      rows: 10_006,
      paused: 'Over 10,000 rows; turn on anyway to index all 10,006 rows (~42 MB).',
    });
    expect(await listSemanticTables()).toEqual([
      expect.objectContaining({
        tableId,
        awaitingConfirm: true,
        indexed: 6,
        paused: expect.stringMatching(/^Over 10,000 rows; turn on anyway/),
      }),
    ]);
    // The Embeddings pane's backfill waits too.
    expect((await classifySemanticEntries()).target).toEqual([]);

    // Search still answers by meaning from the rows already indexed, and says why the rest is not.
    const reply = await search({ query: 'cat' });
    expect(reply.entries.map((entry) => entry.title).sort()).toEqual([
      'Feline care guide',
      'Kitten vaccination schedule',
    ]);
    expect(reply.semantic?.note).toMatch(/grew past 10,000 rows/);

    // A person confirms ("Turn on anyway"): building resumes.
    const confirmed = await setSemanticSearch(tableId, { enabled: true, confirm: true });
    expect(confirmed.awaitingConfirm).toBeUndefined();
    expect(confirmed.paused ?? '').not.toMatch(/^Over/);
    expect(await TableSemantic.getSettings(tableId)).toMatchObject({ confirmedRows: 10_006 });
    expect(await sweepTableEntries({ embedBudget: 5 })).toBe(5);

    // Confirmed, it keeps indexing as it grows further.
    await grow(tableId, 500);
    noteEntriesChanged(tableId);
    expect(await getSemanticStatus(tableId)).not.toHaveProperty('awaitingConfirm');
    expect(await sweepTableEntries({ embedBudget: 5 })).toBe(5);
  });

  it('a table within the cap is never held, and a held one that shrinks back resumes', async () => {
    const tableId = await seedNotes();
    await grow(tableId, 9_994); // exactly 10,000 rows: within the cap
    expect(await getSemanticStatus(tableId)).not.toHaveProperty('awaitingConfirm');
    expect(await sweepTableEntries({ embedBudget: 3 })).toBe(3);

    await grow(tableId, 1);
    noteEntriesChanged(tableId);
    expect(await sweepTableEntries({ embedBudget: 3 })).toBe(0);
    const { rows } = await getDb().query<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [tableId]
    );
    await getDb().query(
      `DELETE FROM user_tables.${quoteIdentifier(rows[0]!.table_name)} WHERE name = 'grown 1'`
    );
    noteEntriesChanged(tableId);
    expect(await sweepTableEntries({ embedBudget: 3 })).toBe(3);
  });

  it('asks for confirmation above 10,000 rows, naming the size, and remembers it', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: false });
    const { rows } = await getDb().query<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [tableId]
    );
    await getDb().query(
      `INSERT INTO user_tables.${quoteIdentifier(rows[0]!.table_name)} (id, name) SELECT gen_random_uuid(), 'n' || g FROM generate_series(1, 10000) g`
    );
    expect(await getSemanticStatus(tableId)).toMatchObject({
      enabled: false,
      rows: 10006,
      rowCap: 10000,
      needsConfirmation: true,
      estimate: { label: '~42 MB' },
    });
    await expect(setSemanticSearch(tableId, { enabled: true })).rejects.toThrow(
      /10,006 rows, more than the 10,000.*~42 MB.*confirm: true/
    );
    expect(await TableSemantic.getSettings(tableId)).toBeNull();
    await setSemanticSearch(tableId, { enabled: true, confirm: true });
    expect(await TableSemantic.getSettings(tableId)).toMatchObject({ confirmedRows: 10006 });
    // Turned on again, the earlier "off" is forgotten.
    expect(await turnedOff()).toEqual({});
  });

  it('says which fields are embedded and which were left out by name, and warns the rule is best-effort', async () => {
    const tableId = await seedNotes();
    const status = await getSemanticStatus(tableId);
    expect(status.cardFields).toEqual(['summary', 'name', 'body']);
    expect(status.excludedByName).toEqual(['api_key']);
    expect(status.warning).toMatch(/best-effort.*another name is embedded/);
    expect((await setSemanticSearch(tableId, { enabled: true })).warning).toBe(status.warning);
  });

  it('never returns a row whose vector outlived it (a failed delete), and keeps the page full', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    // A vector for a row that no longer exists, closer to "cat" than any real row.
    const ghost = '99999999-9999-4999-8999-999999999999';
    await TableSemantic.upsert(tableId, 'concept-embedder', [
      { entryId: ghost, cardHash: 'ghost', vector: vectorFor('cat') },
    ]);
    const reply = await search({ query: 'cat', limit: 2 });
    expect(reply.entries.map((entry) => entry.id)).not.toContain(ghost);
    expect(reply.entries.map((entry) => entry.title).sort()).toEqual([
      'Feline care guide',
      'Kitten vaccination schedule',
    ]);
  });

  it('lists every active table, on or off, with its coverage, and a backfill fills the missing rows', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: false });
    expect(await listSemanticTables()).toEqual([
      expect.objectContaining({
        tableId,
        enabled: false,
        state: 'off',
        indexed: 0,
        rows: 6,
        needsConfirmation: false,
      }),
    ]);
    await setSemanticSearch(tableId, { enabled: true });
    expect(await listSemanticTables()).toMatchObject([
      {
        tableId,
        tableName: 'notes',
        enabled: true,
        rows: 6,
        indexed: 0,
        state: 'indexing',
        projectName: null,
      },
    ]);
    // A person asks for the backfill: it runs in the background and the pane polls.
    expect(await backfillSemanticTable(tableId)).toMatchObject({
      enabled: true,
      tableName: 'notes',
    });
    for (let i = 0; i < 100 && (await getSemanticStatus(tableId)).state !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await listSemanticTables()).toMatchObject([
      { tableName: 'notes', rows: 6, indexed: 6, state: 'ready' },
    ]);
    expect(embedDocument).toHaveBeenCalledTimes(6);
    // Backfilling again embeds nothing: every card hash is unchanged.
    embedDocument.mockClear();
    await backfillSemanticTable(tableId);
    for (let i = 0; i < 100 && (await getSemanticStatus(tableId)).state !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(embedDocument).not.toHaveBeenCalled();
  });

  it('a backfill reaches missing rows that sit after several pages of unchanged ones', async () => {
    const tableId = await seedNotes();
    const { rows } = await getDb().query<{ table_name: string }>(
      'SELECT table_name FROM public.table_catalog WHERE id = $1',
      [tableId]
    );
    const target = `user_tables.${quoteIdentifier(rows[0]!.table_name)}`;
    await getDb().query(
      `INSERT INTO ${target} (id, summary, body) SELECT gen_random_uuid(), 'note ' || g, 'text ' || g FROM generate_series(1, 444) g`
    );
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    expect(await getSemanticStatus(tableId)).toMatchObject({ indexed: 450, state: 'ready' });

    // The 50 rows with the highest id lose their vector: four pages of unchanged rows come first.
    await getDb().query(
      `DELETE FROM public.table_entry_embeddings WHERE table_id = $1 AND entry_id IN (
         SELECT entry_id FROM public.table_entry_embeddings WHERE table_id = $1 ORDER BY entry_id DESC LIMIT 50)`,
      [tableId]
    );
    expect((await getSemanticStatus(tableId)).indexed).toBe(400);
    embedDocument.mockClear();

    await backfillSemanticTable(tableId);
    for (let i = 0; i < 200 && (await getSemanticStatus(tableId)).state !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await getSemanticStatus(tableId)).toMatchObject({ indexed: 450, state: 'ready' });
    expect(embedDocument).toHaveBeenCalledTimes(50);
  });

  it('refuses a backfill for a table that has it off, and leaves archived tables out of the list', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: false });
    await expect(backfillSemanticTable(tableId)).rejects.toThrow(/Turn on search by meaning/);
    await setSemanticSearch(tableId, { enabled: true });
    await applyAgentSchema('notes', { ops: [{ op: 'archive_table' }] });
    expect(await listSemanticTables()).toEqual([]);
  });

  it('the palette entry: search finds rows by meaning for tables that have it on, and stays keyword-only otherwise', async () => {
    const tableId = await seedNotes();
    // Off: "cat" matches no word of any row.
    await setSemanticSearch(tableId, { enabled: false });
    expect(await searchPaletteEntries({ keywords: 'cat', limit: 10, byMeaning: true })).toEqual([]);

    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    const hits = await searchPaletteEntries({ keywords: 'cat', limit: 10, byMeaning: true });
    expect(hits.map((hit) => hit.name).sort()).toEqual([
      'Feline care guide',
      'Kitten vaccination schedule',
    ]);
    expect(hits.every((hit) => hit.score < 0.9 && hit.tableName === 'notes')).toBe(true);
    // A row with the keyword stays first and keeps its keyword score.
    const invoice = await searchPaletteEntries({ keywords: 'invoice', limit: 10, byMeaning: true });
    expect(invoice.map((hit) => hit.name)).toEqual([
      'Quarterly invoice summary',
      'Payment reminders',
    ]);
    expect(invoice[0]!.score).toBeGreaterThan(invoice[1]!.score);
    // Nonsense finds nothing; a named table scopes the meaning search; a browse stays a browse.
    expect(await searchPaletteEntries({ keywords: 'zebra', limit: 10, byMeaning: true })).toEqual(
      []
    );
    expect(
      await searchPaletteEntries({ keywords: 'puppy', tableId, limit: 10, byMeaning: true })
    ).toHaveLength(1);
    expect(await searchPaletteEntries({ keywords: '', limit: 3, byMeaning: true })).toHaveLength(3);
  });

  it('the palette search without byMeaning (the Entries section of every search) never embeds the query', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    embedQuery.mockClear();
    expect(await searchPaletteEntries({ keywords: 'cat', limit: 10 })).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(
      (await searchPaletteEntries({ keywords: 'cat', limit: 10, byMeaning: true })).length
    ).toBeGreaterThan(0);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it('refuses archived and Snaglet tables', async () => {
    await seedNotes();
    await expect(setSemanticSearch('table-builtin-docs', { enabled: true })).rejects.toThrow(
      /Snaglet table/
    );
    await expect(setSemanticSearch('table-1700000000000-nope', { enabled: true })).rejects.toThrow(
      /Table not found/
    );
  });

  it('ranking: keyword-only misses a synonym, keyword + meaning finds it and keeps exact matches first', async () => {
    const tableId = await seedNotes();
    // Before: keyword-only, whatever the mode, cannot find "cat".
    expect((await search({ query: 'cat' })).entries).toEqual([]);

    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();

    const keywordOnly = await search({ query: 'cat', mode: 'keyword' });
    expect(keywordOnly.entries).toEqual([]);
    const hybrid = await search({ query: 'cat' });
    expect(hybrid.entries.map((entry) => entry.title).sort()).toEqual([
      'Feline care guide',
      'Kitten vaccination schedule',
    ]);
    expect(hybrid.entries.every((entry) => entry.match === 'meaning')).toBe(true);
    expect(hybrid.semantic).toMatchObject({ tables: ['notes'], indexing: [], used: true });

    // An exact keyword match stays first; a synonym row follows it.
    const invoice = await search({ query: 'invoice' });
    expect(invoice.entries.map((entry) => [entry.title, entry.match])).toEqual([
      ['Quarterly invoice summary', 'both'],
      ['Payment reminders', 'meaning'],
    ]);
    const keywordInvoice = await search({ query: 'invoice', mode: 'keyword' });
    expect(keywordInvoice.entries.map((entry) => entry.title)).toEqual([
      'Quarterly invoice summary',
    ]);

    // Unrelated rows are not padded in: "zebra" is near nothing.
    expect((await search({ query: 'zebra' })).entries).toEqual([]);
  });

  it('mode:"semantic" orders by meaning; a field filter keeps the search keyword-only', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    const semantic = await search({ query: 'puppy', mode: 'semantic' });
    expect(semantic.entries.map((entry) => entry.title)).toEqual(['Dog training basics']);
    const filtered = await search({
      query: 'cat',
      filters: [{ field: 'summary', operator: 'contains', value: 'care' }],
    });
    expect(filtered.semantic).toBeUndefined();
  });

  it('does not search the vectors of an archived table', async () => {
    const tableId = await seedNotes();
    await setSemanticSearch(tableId, { enabled: true });
    await buildSemanticIndex();
    await applyAgentSchema('notes', { ops: [{ op: 'archive_table' }] });
    expect(await sweepTableEntries()).toBe(0);
    const reply = JSON.parse(
      (await entrySearch({ kinds: ['entry'], query: 'cat' }, {}, undefined)) as string
    ) as Result;
    expect(reply.entries).toEqual([]);
  });

  it('with no table named, searches only the tables of the given project', async () => {
    await Containers.create({ id: PROJECTS[0]!, name: 'Pets', category: 'project' });
    await Containers.create({ id: PROJECTS[1]!, name: 'Finance', category: 'project' });
    const petsId = await seedNotes();
    await applyAgentSchema('notes', { ops: [{ op: 'set_project', project_id: PROJECTS[0] }] });
    const { table: other } = await applyAgentSchema('memos', {
      fields: [{ name: 'summary', type: 'text' }],
      ops: [
        { op: 'set_title_field', name: 'summary' },
        { op: 'set_project', project_id: PROJECTS[1] },
      ],
    });
    await writeAgentEntries('memos', {
      insert: [{ id: ID(7), values: { summary: 'Feline adoption paperwork' } }],
    });
    await setSemanticSearch(petsId, { enabled: true });
    await setSemanticSearch(other.id, { enabled: true });
    await buildSemanticIndex();

    const find = async (extra: Record<string, unknown>) =>
      JSON.parse(
        (await entrySearch(
          { kinds: ['entry'], query: 'cat', mode: 'semantic', ...extra },
          {},
          undefined
        )) as string
      ) as Result;
    const all = await find({});
    expect(all.entries.map((entry) => entry.id)).toContain(ID(7));
    const scoped = await find({ project_id: PROJECTS[0] });
    expect(scoped.entries.length).toBeGreaterThan(0);
    expect(scoped.entries.map((entry) => entry.id)).not.toContain(ID(7));
    expect(scoped.semantic?.tables).toEqual(['notes']);

    // An archived table drops out of the scope, so its vectors don't use the budget.
    await applyAgentSchema('notes', { ops: [{ op: 'archive_table' }] });
    expect(await TableSemantic.listSearchable()).toEqual([other.id]);
    expect(await TableSemantic.listSearchable({ projectId: PROJECTS[0]! })).toEqual([]);
  });
});
