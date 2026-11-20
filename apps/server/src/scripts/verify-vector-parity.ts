/**
 * verify-vector-parity — proves the rewritten vector queries return the same
 * top results as a brute-force reference on a small seeded dataset.
 *
 * Boots a real isolated managed PostgreSQL cluster (full migration chain, so the typed
 * vector(768) column + HNSW index + seeded catalog are exactly production
 * shape), seeds docs (some multi-chunk, some archived), files, and agent
 * memories with deterministic mock vectors, then compares:
 *
 *   1. Embeddings.searchSimilar()          vs brute-force best-chunk ranking
 *   2. workspaceSearchNodes(mode=semantic) vs brute-force over live docs
 *   3. searchFileNodes()                   vs brute-force over file nodes
 *   4. Memories.hybridSearch (vector arm) + findNearDuplicate vs brute force
 *   5. the RAG semantic candidate shape    vs brute force incl. chunk offsets
 *
 * Prints a JSON report; exits non-zero on the first mismatch. The integration
 * suite shells out so PostgreSQL process lifecycle stays isolated from Jest,
 * and hands over the database it already owns.
 *
 * Usage: pnpm --filter @snaglet/server exec tsx src/scripts/verify-vector-parity.ts
 */

/** Set by a caller that owns a disposable, already-migrated database. */
const VERIFIER_DATABASE_URL_ENV = 'SNAGLET_VERIFIER_DATABASE_URL';

async function main(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Decide the database before any @snaglet/db import resolves an adapter.
  //
  // This script seeds 30 docs, files and memories, so it never inherits an
  // ambient SNAGLET_DATABASE_URL: a caller that owns a disposable database hands it
  // over explicitly. With nothing handed over it provisions a throwaway Snaglet
  // home and uses the managed cluster there — the same rule production uses,
  // pointed somewhere disposable.
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  const injectedUrl = process.env[VERIFIER_DATABASE_URL_ENV]?.trim();
  let homeDir: string | undefined;
  if (injectedUrl) {
    process.env.SNAGLET_DATABASE_URL = injectedUrl;
  } else {
    delete process.env.SNAGLET_DATABASE_URL;
    const { resolveDbHome } = await import('@snaglet/db/runtime/snaglet-home');
    // Only data belongs in the throwaway home. The runtime cache would follow
    // SNAGLET_HOME too, and a per-run cache means compiling PostgreSQL from source
    // every run — so pin it to where a normal install already built it.
    process.env.SNAGLET_PG_RUNTIME_DIR ||= join(resolveDbHome(), 'cache', 'postgres-runtime');
    homeDir = await mkdtemp(join(tmpdir(), 'snaglet-parity-home-'));
    process.env.SNAGLET_HOME = homeDir;
  }

  const { closeDatabase, getDbClient } = await import('@snaglet/db/db');
  const { bootstrapIfFresh } = await import('@snaglet/db/migrations');
  const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
  const { vectorLiteral } = await import('@snaglet/shared/utils');
  const { Embeddings } = await import('@snaglet/db/tables/embeddings');
  const { Memories } = await import('@snaglet/db/tables/memories');
  const { MockEmbeddingProvider, setEmbeddingProvider } =
    await import('../services/embedding/EmbeddingProvider');

  const runtimePaths = homeDir ? new PostgresRuntime({ snagletHome: homeDir }) : undefined;
  const db = await getDbClient();
  try {
    await bootstrapIfFresh(db);

    const mock = new MockEmbeddingProvider(768);
    setEmbeddingProvider(mock);

    // Seed catalog rows for the mock provider (createQueryEmbedding resolves
    // the models row for the active provider before searching).
    const MOCK_MODEL_ID = 'model-mock-parity';
    await db.query(
      `INSERT INTO public.providers (id, name, type) VALUES ('mock', 'Mock', 'runtime')
     ON CONFLICT (id) DO NOTHING`
    );
    await db.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
     VALUES ($1, 'mock', 'mock-embedding', 'Mock Embedding', 'embedding', 768)
     ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MOCK_MODEL_ID]
    );

    // Seed content. Deterministic doc vectors come from the same mock the
    // query side uses, so brute force can recompute everything exactly.
    const cos = (a: number[], b: number[]) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i += 1) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    };
    // pgvector stores float4 — mirror that quantization so brute-force
    // distances match the DB's to float precision.
    const f32 = (v: number[]) => Array.from(new Float32Array(v));

    interface SeededChunk {
      nodeId: string;
      chunkIndex: number;
      vector: number[];
      archived: boolean;
      kind: 'doc' | 'memory';
    }
    const chunks: SeededChunk[] = [];
    // File embeddings are content-addressed (file_embeddings): one vector
    // per unique content_hash, referenced by any number of file rows.
    interface SeededFileContent {
      contentHash: string;
      vector: number[];
      /** Expected primary node (first by project_id, relative_path among live refs). */
      primaryNodeId: string;
      /** All live (non-archived) reference node ids. */
      liveNodeIds: string[];
    }
    const fileContents: SeededFileContent[] = [];

    const insertEmbedding = async (
      id: string,
      nodeId: string,
      vector: number[],
      chunkIndex: number
    ) => {
      await db.query(
        `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $5, $6)`,
        [id, nodeId, MOCK_MODEL_ID, vectorLiteral(vector), `hash-${nodeId}`, chunkIndex]
      );
    };

    // 30 docs; every third has 3 chunks; every seventh archived.
    for (let i = 0; i < 30; i += 1) {
      const nodeId = `doc-parity-${i}`;
      const archived = i % 7 === 6;
      await db.query(
        archived
          ? `INSERT INTO public.nodes (id, type, archived, archived_at) VALUES ($1, 'doc', true, now())`
          : `INSERT INTO public.nodes (id, type) VALUES ($1, 'doc')`,
        [nodeId]
      );
      await db.query(`INSERT INTO public.docs (id, title, content) VALUES ($1, $2, $3)`, [
        nodeId,
        `Parity doc ${i}`,
        `parity content ${i}`,
      ]);
      const chunkCount = i % 3 === 0 ? 3 : 1;
      for (let c = 0; c < chunkCount; c += 1) {
        const vector = f32(await mock.embedDocument(`doc-${i}-chunk-${c}`));
        await insertEmbedding(`emb-${nodeId}-${c}`, nodeId, vector, c);
        chunks.push({ nodeId, chunkIndex: c, vector, archived, kind: 'doc' });
      }
    }

    // A project container + 10 file nodes (2 in a subdirectory, 1 archived,
    // 2 sharing one content hash — the content-dedup case). A project is a
    // container with category='project'; files hang off its id. Embeddings go
    // to file_embeddings keyed by content_hash (one row per unique content).
    await db.query(`INSERT INTO public.nodes (id, type) VALUES ('container-parity', 'container')`);
    await db.query(
      `INSERT INTO public.containers (id, name, category) VALUES ('container-parity', 'Parity Container', 'project')
     ON CONFLICT (id) DO NOTHING`
    );
    const insertFileEmbedding = async (id: string, contentHash: string, vector: number[]) => {
      await db.query(
        `INSERT INTO public.file_embeddings (id, content_hash, model_id, vector, chunk_index)
       VALUES ($1, $2, $3, $4::vector, 0)`,
        [id, contentHash, MOCK_MODEL_ID, vectorLiteral(vector)]
      );
    };
    const refsByHash = new Map<
      string,
      Array<{ nodeId: string; relativePath: string; archived: boolean }>
    >();
    for (let i = 0; i < 10; i += 1) {
      const nodeId = `file-parity-${i}`;
      const archived = i === 9;
      // Files 7 and 8 reference the same content — one embedding, two paths.
      const contentHash = i === 8 ? 'fhash-7' : `fhash-${i}`;
      const relativePath = i < 2 ? `src/deep/file-${i}.ts` : `file-${i}.ts`;
      await db.query(
        archived
          ? `INSERT INTO public.nodes (id, type, archived, archived_at) VALUES ($1, 'file', true, now())`
          : `INSERT INTO public.nodes (id, type) VALUES ($1, 'file')`,
        [nodeId]
      );
      await db.query(
        `INSERT INTO public.files (id, project_id, relative_path, content_hash, size_bytes)
       VALUES ($1, 'container-parity', $2, $3, 100)`,
        [nodeId, relativePath, contentHash]
      );
      const refs = refsByHash.get(contentHash) ?? [];
      refs.push({ nodeId, relativePath, archived });
      refsByHash.set(contentHash, refs);
      if (i !== 8) {
        const vector = f32(await mock.embedDocument(`file-content-${contentHash}`));
        await insertFileEmbedding(`femb-${contentHash}`, contentHash, vector);
        fileContents.push({ contentHash, vector, primaryNodeId: '', liveNodeIds: [] });
      }
    }
    for (const content of fileContents) {
      const live = (refsByHash.get(content.contentHash) ?? [])
        .filter((ref) => !ref.archived)
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
      content.liveNodeIds = live.map((ref) => ref.nodeId);
      content.primaryNodeId = live[0]?.nodeId ?? '';
    }

    // An agent with 12 memories (plus another agent's memory that must never leak).
    // Agents are actors, not nodes: no public.nodes row.
    await db.query(`INSERT INTO public.agents (id, name) VALUES ('agent-parity', 'Parity Agent')`);
    await db.query(`INSERT INTO public.agents (id, name) VALUES ('agent-other', 'Other Agent')`);
    const memoryVectors = new Map<string, number[]>();
    for (let i = 0; i < 12; i += 1) {
      const nodeId = `memory-parity-${i}`;
      await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'memory')`, [nodeId]);
      await db.query(
        `INSERT INTO public.memories (id, agent_id, memory_key, content) VALUES ($1, $2, $3, $4)`,
        [nodeId, 'agent-parity', `key-${i}`, `memory content ${i}`]
      );
      const vector = f32(await mock.embedDocument(`memory-${i}`));
      await insertEmbedding(`emb-${nodeId}`, nodeId, vector, 0);
      memoryVectors.set(nodeId, vector);
      chunks.push({ nodeId, chunkIndex: 0, vector, archived: false, kind: 'memory' });
    }
    await db.query(`INSERT INTO public.nodes (id, type) VALUES ('memory-other', 'memory')`);
    await db.query(
      `INSERT INTO public.memories (id, agent_id, memory_key, content)
     VALUES ('memory-other', 'agent-other', 'other', 'other agent memory')`
    );
    const otherVector = f32(await mock.embedDocument('memory-0'));
    await insertEmbedding('emb-memory-other', 'memory-other', otherVector, 0);
    chunks.push({
      nodeId: 'memory-other',
      chunkIndex: 0,
      vector: otherVector,
      archived: false,
      kind: 'memory',
    });

    await db.query('ANALYZE public.embeddings');
    await db.query('ANALYZE public.file_embeddings');

    // Brute-force reference helpers
    const queryText = 'find the parity content';
    const queryVec = f32(await mock.embedQuery(queryText));

    /** Best-chunk-per-node distances, optionally filtered, sorted ASC. */
    const bruteBest = (filter: (chunk: SeededChunk) => boolean) => {
      const best = new Map<string, number>();
      for (const chunk of chunks) {
        if (!filter(chunk)) continue;
        const distance = 1 - cos(chunk.vector, queryVec);
        const prev = best.get(chunk.nodeId);
        if (prev === undefined || distance < prev) best.set(chunk.nodeId, distance);
      }
      return [...best.entries()]
        .map(([nodeId, distance]) => ({ nodeId, distance }))
        .sort((a, b) => a.distance - b.distance || (a.nodeId < b.nodeId ? -1 : 1));
    };

    const failures: string[] = [];
    const check = (label: string, actual: string[], expected: string[]) => {
      const ok =
        actual.length === expected.length && actual.every((id, index) => id === expected[index]);
      if (!ok) {
        failures.push(
          `${label}\n  expected: ${expected.join(', ')}\n  actual:   ${actual.join(', ')}`
        );
      }
    };

    // 1. Embeddings.searchSimilar — no archived/kind filtering by design.
    const similar = await Embeddings.searchSimilar(queryVec, MOCK_MODEL_ID, 10);
    check(
      'searchSimilar top-10 (best-chunk dedup)',
      similar.map((hit) => hit.nodeId),
      bruteBest(() => true)
        .slice(0, 10)
        .map((hit) => hit.nodeId)
    );

    // 2. workspaceSearchNodes semantic — live docs only, root scope.
    const { workspaceSearchNodes } = await import('../services/search/nodeSearch');
    const nodeResult = await workspaceSearchNodes({
      query: queryText,
      kind: 'doc',
      scope: { container_id: 'root' },
      mode: 'semantic',
      limit: 10,
    });
    check(
      'workspaceSearchNodes(doc, semantic) top-10',
      nodeResult.hits.map((hit) => hit.node_id),
      bruteBest((chunk) => chunk.kind === 'doc' && !chunk.archived)
        .slice(0, 10)
        .map((hit) => hit.nodeId)
    );

    // 3. searchFileNodes — one hit per unique content (closest first), each
    //    represented by its first live (project_id, relative_path) reference;
    //    then with a path-prefix filter.
    const { searchFileNodes } = await import('../services/search/fileNodeSearch');
    const bruteFileContents = (filter: (content: SeededFileContent) => boolean) =>
      fileContents
        .filter((content) => filter(content) && content.liveNodeIds.length > 0)
        .map((content) => ({ content, distance: 1 - cos(content.vector, queryVec) }))
        .sort(
          (a, b) =>
            a.distance - b.distance || (a.content.contentHash < b.content.contentHash ? -1 : 1)
        );
    const fileHits = await searchFileNodes(queryText, 8);
    check(
      'searchFileNodes top-8 (content dedup)',
      fileHits.map((hit) => hit.nodeId),
      bruteFileContents(() => true)
        .slice(0, 8)
        .map((hit) => hit.content.primaryNodeId)
    );
    // The shared-content hit must list both referencing paths.
    const sharedHit = fileHits.find((hit) => hit.contentHash === 'fhash-7');
    if (!sharedHit) {
      failures.push('searchFileNodes: shared-content hit (fhash-7) missing from top-8');
    } else if (
      sharedHit.paths.length !== 2 ||
      !sharedHit.paths.some((p) => p.relativePath === 'file-7.ts') ||
      !sharedHit.paths.some((p) => p.relativePath === 'file-8.ts')
    ) {
      failures.push(
        `searchFileNodes: shared-content hit should list file-7.ts + file-8.ts, got ${sharedHit.paths
          .map((p) => p.relativePath)
          .join(', ')}`
      );
    }
    const deepHits = await searchFileNodes(queryText, 8, {
      projectId: 'container-parity',
      relativePathPrefix: 'src/deep',
    });
    check(
      'searchFileNodes with project + path-prefix filters',
      deepHits.map((hit) => hit.nodeId),
      bruteFileContents((content) => ['fhash-0', 'fhash-1'].includes(content.contentHash))
        .slice(0, 8)
        .map((hit) => hit.content.primaryNodeId)
    );

    // 4. Memory recall — vector arm ordering + near-duplicate + agent isolation.
    const recalled = await Memories.hybridSearch(queryVec, '', 'agent-parity', { limit: 5 });
    const bruteMemories = [...memoryVectors.entries()]
      .map(([nodeId, vector]) => ({ nodeId, distance: 1 - cos(vector, queryVec) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
    check(
      'Memories.hybridSearch vector arm top-5 (agent-scoped)',
      recalled.map((row) => row.id),
      bruteMemories.map((row) => row.nodeId)
    );
    if (recalled.some((row) => row.id === 'memory-other')) {
      failures.push("memory recall leaked another agent's memory");
    }
    const dupe = await Memories.findNearDuplicate(
      'agent-parity',
      memoryVectors.get('memory-parity-3')!,
      0.95
    );
    if (dupe?.id !== 'memory-parity-3') {
      failures.push(`findNearDuplicate expected memory-parity-3, got ${dupe?.id ?? 'null'}`);
    }

    // 5. RAG semantic candidate shape — same SQL as semanticVectorCandidates'
    //    inner query; verifies the winning chunk (offsets) survives the rewrite.
    const { rows: ragRows } = await db.query<{ node_id: string; chunk_index: number }>(
      `SELECT DISTINCT ON (node_id) node_id, chunk_index
     FROM (
       SELECT node_id, (vector <=> $1::vector) AS distance, chunk_index
       FROM public.embeddings
       WHERE model_id = $2
       ORDER BY vector <=> $1::vector
       LIMIT 100
     ) pool
     ORDER BY node_id, distance ASC`,
      [vectorLiteral(queryVec), MOCK_MODEL_ID]
    );
    const bruteWinners = new Map<string, { chunkIndex: number; distance: number }>();
    for (const chunk of chunks) {
      const distance = 1 - cos(chunk.vector, queryVec);
      const prev = bruteWinners.get(chunk.nodeId);
      if (!prev || distance < prev.distance) {
        bruteWinners.set(chunk.nodeId, { chunkIndex: chunk.chunkIndex, distance });
      }
    }
    for (const row of ragRows) {
      const expected = bruteWinners.get(row.node_id);
      if (expected && expected.chunkIndex !== row.chunk_index) {
        failures.push(
          `RAG winning chunk mismatch for ${row.node_id}: expected ${expected.chunkIndex}, got ${row.chunk_index}`
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
    }
    console.log(
      JSON.stringify({
        ok: true,
        engine: 'managed-postgres',
        checks: [
          'searchSimilar',
          'workspaceSearchNodes-semantic',
          'searchFileNodes',
          'searchFileNodes-filtered',
          'memories-hybrid-vector-arm',
          'memories-near-duplicate',
          'rag-winning-chunk',
        ],
      })
    );
  } finally {
    // A handed-over database belongs to the caller: close the pool and stop.
    // A scratch cluster is this verifier's own even though it intentionally
    // does not set SNAGLET_PG_OWNED (that flag is reserved for packaged runtime
    // policy), so end the pool first, then stop the server, then remove paths.
    await closeDatabase();
    if (runtimePaths && homeDir) {
      await runtimePaths.stop('fast');
      await rm(runtimePaths.socketDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  }
}

main().catch(async (err: unknown) => {
  const { getErrorMessage } = await import('@snaglet/shared/utils');
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error && err.stack ? err.stack : getErrorMessage(err),
    })
  );
  process.exitCode = 1;
});
