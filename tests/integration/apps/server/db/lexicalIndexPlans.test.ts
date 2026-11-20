/**
 * Query-plan proof for the persisted lexical vectors. An index existing proves
 * nothing about whether queries use it: wrapping the column in
 * `COALESCE(search_text, to_tsvector(...))` makes the predicate non-indexable.
 * So these tests read the actual plan, two ways:
 *   - Eligibility (`enable_seqscan = off`): can the planner use the named GIN
 *     index for the exact production predicate at all? Deterministic and
 *     independent of table size.
 *   - Realism (default settings, ANALYZE'd fixture at volume): does the planner
 *     choose the index when free to? A tiny table makes a sequential scan
 *     cheaper, so these seed enough rows for the index to win honestly.
 * Plans are walked recursively from `EXPLAIN (FORMAT JSON)`; the index scan
 * sits under Bitmap Heap Scan → Bitmap Index Scan.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeDatabase, transaction } from '@snaglet/db';
import type { DbClient } from '@snaglet/db/adapters/types';

class RollbackSentinel extends Error {}

/** Rows seeded so the planner genuinely prefers the index over a seq scan. */
const FIXTURE_ROWS = 6000;
/** Files rows are narrower than messages, so more of them are needed. */
const FILE_FIXTURE_ROWS = 45000;
/**
 * Padding so the heap spans enough pages for the index to be the honest choice.
 * Row count alone is not the lever: 6,000 narrow rows occupy ~500 pages and the
 * planner correctly prefers a sequential scan over them. The same 6,000 rows at
 * realistic message width occupy ~1,500 pages, and it switches to a bitmap
 * index scan on its own. Kept under the ~2KB TOAST threshold, since TOASTing
 * would move the text out of the heap and shrink the main relation again.
 */
const FILLER = "repeat('lorem ipsum dolor sit amet consectetur ', 34)";
/** Appears in exactly one row, so the index is highly selective. */
const RARE_TERM = 'zorptastic';

interface PlanNode {
  'Node Type'?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/** Flatten a plan tree — the index scan is never the root node. */
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

async function explain(tx: DbClient, sql: string, params: unknown[] = []): Promise<PlanNode[]> {
  const { rows } = await tx.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    params
  );
  const plan = rows[0]['QUERY PLAN'][0].Plan;
  return flattenPlan(plan);
}

const usesIndex = (nodes: PlanNode[], indexName: string): boolean =>
  nodes.some((n) => n['Index Name'] === indexName);

const seqScansRelation = (nodes: PlanNode[], relation: string): boolean =>
  nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === relation);

async function inRollback(body: (tx: DbClient) => Promise<void>): Promise<void> {
  await expect(
    transaction(async (tx) => {
      await body(tx);
      throw new RollbackSentinel();
    })
  ).rejects.toBeInstanceOf(RollbackSentinel);
}

/**
 * The exact predicates the production code issues. If a query here drifts from
 * the shipped SQL, these plans stop meaning anything — the static check at the
 * bottom of this file is what keeps them honest.
 */
const LANES = [
  {
    name: 'messages',
    index: 'messages_search_text_idx',
    relation: 'messages',
    sql: `SELECT id FROM public.messages WHERE search_text @@ websearch_to_tsquery('english', $1)`,
  },
  {
    name: 'memories',
    index: 'memories_search_text_idx',
    relation: 'memories',
    sql: `SELECT id FROM public.memories WHERE search_text @@ plainto_tsquery('english', $1)`,
  },
  {
    name: 'thread_summaries',
    index: 'thread_summaries_search_text_idx',
    relation: 'thread_summaries',
    sql: `SELECT id FROM public.thread_summaries WHERE search_text @@ websearch_to_tsquery('english', $1)`,
  },
  {
    name: 'tools',
    index: 'tools_search_text_idx',
    relation: 'tools',
    sql: `SELECT id FROM public.tools WHERE search_text @@ (websearch_to_tsquery('simple', $1) || websearch_to_tsquery('english', $1))`,
  },
  {
    name: 'files',
    index: 'files_search_text_idx',
    relation: 'files',
    sql: `SELECT id FROM public.files WHERE search_text @@ (websearch_to_tsquery('simple', $1) || websearch_to_tsquery('simple', translate($1, '/\\.-_', '     ')))`,
  },
] as const;

afterAll(async () => {
  await closeDatabase();
});

describe('GIN eligibility for the exact production predicates', () => {
  it.each(LANES.map((lane) => [lane.name, lane] as const))(
    '%s can use its GIN index',
    async (_name, lane) => {
      await inRollback(async (tx) => {
        // Forces the question "is this predicate indexable at all?" and takes
        // table size out of the answer. A non-indexable wrapper around the
        // column fails here even with seqscan disabled.
        await tx.query('SET LOCAL enable_seqscan = off');
        const nodes = await explain(tx, lane.sql, [RARE_TERM]);

        expect(usesIndex(nodes, lane.index)).toBe(true);
        expect(nodes.some((n) => (n['Node Type'] ?? '').includes('Bitmap Index Scan'))).toBe(true);
      });
    }
  );

  it('a COALESCE-wrapped predicate is not index-eligible', async () => {
    await inRollback(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      // This wrapper cannot use the index even with sequential scans
      // disabled: an indexed column does not make the wrapped expression
      // indexable.
      const nodes = await explain(
        tx,
        `SELECT id FROM public.messages
          WHERE COALESCE(search_text, to_tsvector('english', COALESCE(content, ''))) @@ websearch_to_tsquery('english', $1)`,
        [RARE_TERM]
      );
      expect(usesIndex(nodes, 'messages_search_text_idx')).toBe(false);
    });
  });
});

describe('the planner chooses the index at realistic volume', () => {
  it('messages: bitmap index scan, no sequential scan', async () => {
    await inRollback(async (tx) => {
      await tx.query(`INSERT INTO public.nodes (id, type) VALUES ('t-plan', 'thread')`);
      // Every message insert fires a trigger that advances this thread's
      // last_message_at. Thousands of updates to one row inside one open
      // transaction each walk the row's growing version chain — quadratic, and
      // the dominant cost of this fixture. Starting the thread at 'infinity'
      // leaves the trigger running but its UPDATE matching nothing.
      await tx.query(
        `INSERT INTO public.threads (id, title, last_message_at)
         VALUES ('t-plan', 'Plan fixture', 'infinity')`
      );
      await tx.query(
        `INSERT INTO public.nodes (id, type)
         SELECT 'm-plan-' || g, 'message' FROM generate_series(1, $1) g`,
        [FIXTURE_ROWS]
      );
      await tx.query(
        `INSERT INTO public.messages (id, thread_id, role, content)
         SELECT 'm-plan-' || g, 't-plan', 'user',
                'routine conversation filler number ' || g || ' ' || ${FILLER}
           FROM generate_series(1, $1) g`,
        [FIXTURE_ROWS]
      );
      await tx.query(
        `UPDATE public.messages SET content = 'the ' || $1 || ' rollout plan' WHERE id = 'm-plan-1'`,
        [RARE_TERM]
      );
      // Without fresh statistics the planner is guessing, and the assertion
      // below would be measuring the guess rather than the index.
      await tx.query('ANALYZE public.messages');

      const nodes = await explain(
        tx,
        `SELECT id FROM public.messages WHERE search_text @@ websearch_to_tsquery('english', $1)`,
        [RARE_TERM]
      );

      expect(usesIndex(nodes, 'messages_search_text_idx')).toBe(true);
      expect(seqScansRelation(nodes, 'messages')).toBe(false);
      // And it must still return the right row, not merely a fast wrong plan.
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM public.messages WHERE search_text @@ websearch_to_tsquery('english', $1)`,
        [RARE_TERM]
      );
      expect(rows.map((r) => r.id)).toEqual(['m-plan-1']);
    });
  }, 60_000);

  it('memories: bitmap index scan, no sequential scan', async () => {
    await inRollback(async (tx) => {
      await tx.query(
        `INSERT INTO public.nodes (id, type)
         SELECT 'mem-plan-' || g, 'memory' FROM generate_series(1, $1) g`,
        [FIXTURE_ROWS]
      );
      await tx.query(
        `INSERT INTO public.memories (id, agent_id, memory_key, content)
         SELECT 'mem-plan-' || g, 'ghost', 'key_' || g,
                'ordinary remembered detail ' || g || ' ' || ${FILLER}
           FROM generate_series(1, $1) g`,
        [FIXTURE_ROWS]
      );
      await tx.query(`UPDATE public.memories SET memory_key = $1 WHERE id = 'mem-plan-1'`, [
        RARE_TERM,
      ]);
      await tx.query('ANALYZE public.memories');

      const nodes = await explain(
        tx,
        `SELECT id FROM public.memories WHERE search_text @@ plainto_tsquery('english', $1)`,
        [RARE_TERM]
      );

      expect(usesIndex(nodes, 'memories_search_text_idx')).toBe(true);
      expect(seqScansRelation(nodes, 'memories')).toBe(false);
    });
  }, 60_000);

  it('files: bitmap index scan for a path segment, no sequential scan', async () => {
    await inRollback(async (tx) => {
      await tx.query(`INSERT INTO public.nodes (id, type) VALUES ('proj-plan', 'container')`);
      await tx.query(
        `INSERT INTO public.containers (id, name, category) VALUES ('proj-plan', 'PlanProj', 'project')`
      );
      await tx.query(
        `INSERT INTO public.nodes (id, type)
         SELECT 'f-plan-' || g, 'file' FROM generate_series(1, $1) g`,
        [FILE_FIXTURE_ROWS]
      );
      await tx.query(
        `INSERT INTO public.files (id, project_id, relative_path, content_hash)
         SELECT 'f-plan-' || g, 'proj-plan',
                'packages/' || g || '/src/' || repeat('deeply/nested/segment/', 8) || 'handler' || g || '.ts',
                'hash-' || g
           FROM generate_series(1, $1) g`,
        [FILE_FIXTURE_ROWS]
      );
      await tx.query(
        `UPDATE public.files SET relative_path = 'apps/' || $1 || '/index.ts' WHERE id = 'f-plan-1'`,
        [RARE_TERM]
      );
      await tx.query('ANALYZE public.files');

      const sql = `SELECT id FROM public.files WHERE search_text @@ (websearch_to_tsquery('simple', $1) || websearch_to_tsquery('simple', translate($1, '/\\.-_', '     ')))`;
      const nodes = await explain(tx, sql, [RARE_TERM]);

      expect(usesIndex(nodes, 'files_search_text_idx')).toBe(true);
      expect(seqScansRelation(nodes, 'files')).toBe(false);
    });
  }, 60_000);
});

describe('production SQL keeps the stored lanes indexable', () => {
  // The plan tests above run hand-written predicates. This is what ties them to
  // the shipped code: if a lane adds a per-row `to_tsvector`, the plans stay
  // green while production silently falls back to sequential scans.
  const STORED_LANE_FILES = [
    'apps/server/src/services/ToolService/handlers/search/workspaceSearch/lexical.ts',
    'apps/server/src/services/ToolService/handlers/search/workspaceSearch/semantic.ts',
    'apps/server/src/services/search/paletteSearchQueries.ts',
    'packages/db/tables/memories/MemoryModel.ts',
  ];

  const repoRoot = join(__dirname, '../../../../..');

  /** Strip comments so prose that mentions to_tsvector doesn't trip this. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it.each(STORED_LANE_FILES)('%s issues no runtime to_tsvector', async (relativePath) => {
    const source = stripComments(await readFile(join(repoRoot, relativePath), 'utf8'));
    expect(source).not.toContain('to_tsvector');
  });

  it('ftsSearchNodes keeps to_tsvector only for the un-vectored title lanes', async () => {
    const source = stripComments(
      await readFile(join(repoRoot, 'apps/server/src/services/search/ftsSearchNodes.ts'), 'utf8')
    );
    const occurrences = source.match(/to_tsvector/g) ?? [];
    // threads/containers deliberately have no stored vector — short titles are
    // served by the pg_trgm index instead. Exactly one expression
    // may remain, and it must be the title one.
    expect(occurrences).toHaveLength(1);
    expect(source).toMatch(/to_tsvector\('english', COALESCE\(\$\{titleExpression\}, ''\)\)/);
  });
});
