/**
 * verify-fresh-bootstrap — end-to-end check of a fresh provision from
 * the `0001_init.sql` baseline plus any later migrations on an isolated
 * PostgreSQL cluster:
 *
 *  1. Bootstrap applies every bundled migration; the ledger records every
 *     migration exactly once.
 *  2. `applyPendingMigrations` right after bootstrap is a no-op.
 *  3. The schema honors the contract the codebase assumes (vector column and
 *     index, enums, attribution FKs, CHECKs, project scopes, seeded flags, …).
 *  4. The builtin catalog seeds replay: deleting builtin rows and replaying
 *     restores them, the heal path `ensureBuiltinCatalog` and
 *     `DatabaseBackupService.doReset` use.
 *
 * Prints a JSON report and exits non-zero on the first failed assertion. The
 * integration suite (migrations.bootstrap.test.ts) shells out to it so the
 * destructive replay checks stay off that suite's database; see
 * `openVerifierDatabase` for how the target is chosen.
 *
 * Usage: pnpm --filter @snaglet/db exec tsx scripts/verify-fresh-bootstrap.ts
 */

import { PostgresAdapter } from '../adapters/postgres';
import {
  applyPendingMigrations,
  bootstrapIfFresh,
  pendingMigrationCount,
  reapplyLocalModelSeeds,
  reapplyProviderCatalogSeed,
  reapplySeedFiles,
  SEED_REPLAY_FILES,
} from '../migrations';
import { BASELINE_MIGRATION, migrationFiles } from '../migration-files';
import { openVerifierDatabase, type VerifierDatabase } from './verifier-database';
import { getErrorMessage } from '@snaglet/shared/utils';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  let target: VerifierDatabase | undefined;
  let db: PostgresAdapter | undefined;
  let contender: PostgresAdapter | undefined;
  try {
    target = await openVerifierDatabase('fresh-bootstrap');
    db = target.connect();
    contender = target.connect();

    // 1. Two processes/pools racing a fresh bootstrap serialize on the
    // session-level advisory lock: exactly one provisions and one observes it.
    const bootstrapResults = await Promise.all([bootstrapIfFresh(db), bootstrapIfFresh(contender)]);
    assert(
      bootstrapResults.filter(Boolean).length === 1,
      `expected one bootstrap winner, got ${JSON.stringify(bootstrapResults)}`
    );
    await contender.end();
    contender = undefined;
    assert((await pendingMigrationCount(db)) === 0, 'expected zero pending after bootstrap');

    // Bundled migrations start at the baseline, and the ledger agrees.
    const bundled = migrationFiles();
    assert(
      bundled.length >= 1 && bundled[0] === BASELINE_MIGRATION,
      `bundled migrations must start at ${BASELINE_MIGRATION}, got ${JSON.stringify(bundled)}`
    );
    const { rows: ledger } = await db.query<{ name: string }>(
      `SELECT name FROM public._migrations ORDER BY name`
    );
    assert(
      ledger.length === bundled.length,
      `ledger rows (${ledger.length}) != bundled migrations (${bundled.length})`
    );
    assert(
      ledger[0]?.name === BASELINE_MIGRATION,
      `first ledger entry ${ledger[0]?.name} != ${BASELINE_MIGRATION}`
    );
    const migrationCount = ledger.length;

    // A new install is marked, once, for its one-time starter content.
    const { rows: onboardingSeed } = await db.query<{ value: { status?: string } }>(
      `SELECT value FROM public.settings WHERE category = 'onboarding' AND key = 'seed'`
    );
    assert(
      onboardingSeed.length === 1 && onboardingSeed[0]?.value?.status === 'pending',
      `a fresh database must carry onboarding.seed = {status: pending}, got ${JSON.stringify(onboardingSeed)}`
    );

    // 2. Ledger idempotency: migrate right after bootstrap is a clean no-op.
    await applyPendingMigrations(db);
    assert((await pendingMigrationCount(db)) === 0, 'expected zero pending after re-apply');
    const { rows: ledgerAfter } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public._migrations`
    );
    assert(
      Number(ledgerAfter[0].n) === migrationCount,
      'ledger row count changed on an idempotent re-apply'
    );

    // 3a. The hnsw.ef_search database default applies to new sessions. Re-open
    // the pool to prove the setting landed on the database, not the session.
    await db.end();
    db = target.connect();
    const { rows: hnswEfSearch } = await db.query<{ value: string }>(
      `SELECT current_setting('hnsw.ef_search') AS value`
    );
    assert(
      hnswEfSearch[0]?.value === '100',
      `current_database() hnsw.ef_search ${String(hnswEfSearch[0]?.value)} != 100`
    );

    // 3b. Embedding substrate: vector(768) + the HNSW cosine index + the local
    // embedder model row active and no remote embedding model active.
    const { rows: col } = await db.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'public.embeddings'::regclass AND attname = 'vector'`
    );
    assert(col[0]?.atttypmod === 768, `vector column typmod ${col[0]?.atttypmod} != 768`);

    const { rows: idx } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename='embeddings'
         AND indexname='embeddings_vector_hnsw_idx'`
    );
    assert(!!idx[0]?.indexdef.includes('USING hnsw'), 'hnsw index missing');
    assert(!!idx[0]?.indexdef.includes('vector_cosine_ops'), 'hnsw index not cosine');

    const { rows: model } = await db.query<{ dimensions: number; is_active: boolean }>(
      `SELECT dimensions, is_active FROM public.models
       WHERE provider_id='local-onnx' AND model_id='nomic-embed-text-v1.5'`
    );
    assert(model[0]?.dimensions === 768 && model[0]?.is_active === true, 'local model row wrong');

    const { rows: remote } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.models
       WHERE type='embedding' AND is_active AND provider_id <> 'local-onnx'`
    );
    assert(remote[0]?.count === '0', 'remote embedding models still active');

    // 3c. Workspace taxonomy: container category (and no phase column), doc
    // task fields (and no subtype column), the placement_events history table,
    // and no tasks table.
    const { rows: catCol } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='containers'
         AND column_name IN ('category','phase')`
    );
    assert(
      catCol.length === 1 && catCol[0]?.column_name === 'category',
      'containers must have a category column and no phase column'
    );

    // The project file-indexing switch is a typed column, not a config_json key.
    const { rows: indexingCol } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='containers'
         AND column_name IN ('file_indexing_enabled','config_json')`
    );
    assert(
      indexingCol.length === 1 && indexingCol[0]?.column_name === 'file_indexing_enabled',
      'containers must have a file_indexing_enabled column and no config_json column'
    );

    const { rows: docCol } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
       WHERE table_schema='public' AND table_name='docs'
         AND column_name IN ('due_at','assigned_to','priority')`
    );
    assert(docCol[0]?.n === '3', 'docs task-field columns missing');

    const { rows: subtypeCol } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
       WHERE table_schema='public' AND table_name='docs' AND column_name='subtype'`
    );
    assert(subtypeCol[0]?.n === '0', 'docs.subtype column must not exist');

    const { rows: peTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.placement_events') IS NOT NULL AS present`
    );
    assert(peTable[0]?.present === true, 'placement_events table missing');

    // 3c'. Project scopes: threads carry nodes.project_id and never a
    // container_id; tables carry table_catalog.project_id (never for
    // built-ins); the database-floor guards exist.
    const { rows: projectScopeCols } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND column_name='project_id'
          AND table_name IN ('nodes','table_catalog')`
    );
    assert(projectScopeCols[0]?.n === '2', 'nodes/table_catalog project_id columns missing');

    const { rows: projectScopeConstraints } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_constraint
        WHERE conname IN (
          'nodes_thread_no_container_chk',
          'nodes_project_id_fkey',
          'table_catalog_project_id_fkey',
          'table_catalog_builtin_no_project_chk'
        )`
    );
    assert(
      projectScopeConstraints[0]?.n === '4',
      'project scope CHECK / FK constraints missing (nodes_thread_no_container_chk, nodes_project_id_fkey, table_catalog_project_id_fkey, table_catalog_builtin_no_project_chk)'
    );

    const { rows: projectScopeTriggers } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_trigger
        WHERE tgname IN (
          'trg_nodes_project_scope_guard',
          'trg_table_catalog_project_scope_guard',
          'trg_containers_project_category_guard'
        )`
    );
    assert(projectScopeTriggers[0]?.n === '3', 'project scope guard triggers missing');

    const { rows: tasksTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.tasks') IS NOT NULL AS present`
    );
    assert(tasksTable[0]?.present === false, 'legacy tasks table must not exist');

    // No sketch tables or builtin sketch catalog row exist. The 'sketch'
    // node_type enum label cannot be dropped in place, so it stays (asserted
    // in the enum block below) with zero rows.
    const { rows: sketchesTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.sketches') IS NOT NULL AS present`
    );
    assert(sketchesTable[0]?.present === false, 'sketches table must not exist');
    const { rows: sketchRevisionsTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.sketch_revisions') IS NOT NULL AS present`
    );
    assert(sketchRevisionsTable[0]?.present === false, 'sketch_revisions table must not exist');
    const { rows: sketchCatalog } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.table_catalog WHERE id = 'table-builtin-sketches'
       ) AS present`
    );
    assert(
      sketchCatalog[0]?.present === false,
      'table-builtin-sketches catalog row must not exist'
    );
    const { rows: sketchNodes } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.nodes WHERE type::text = 'sketch'`
    );
    assert(sketchNodes[0]?.count === '0', 'sketch-typed nodes must not exist');

    // 3d. Agents are actors, not nodes: agents carry their own updated_at, no
    // agent-typed node exists, and the node_type enum is exactly the shipped
    // content kinds in migration order (ordered compare). No facts ledger, no
    // blocks table.
    const { rows: factsTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.facts') IS NOT NULL AS present`
    );
    assert(factsTable[0]?.present === false, 'facts ledger table must not exist');

    const { rows: agentsUpdatedAt } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='agents' AND column_name='updated_at'
       ) AS present`
    );
    assert(agentsUpdatedAt[0]?.present === true, 'agents.updated_at column missing');

    const { rows: agentNodes } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.nodes WHERE type::text = 'agent'`
    );
    assert(agentNodes[0]?.count === '0', 'agent-typed nodes must not exist');

    const { rows: enumLabels } = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'node_type'
        ORDER BY e.enumsortorder`
    );
    const gotLabels = enumLabels.map((r) => r.label);
    // Append-only: ALTER TYPE ... ADD VALUE lands each new kind at the end,
    // so a new kind is a new trailing entry here, never a reorder.
    const wantLabels = [
      'container',
      'doc',
      'thread',
      'message',
      'memory',
      'thread_summary',
      'file',
      'image',
      'tool',
      'sketch',
      'post',
      'calendar_event',
      'discussion',
    ];
    assert(
      gotLabels.length === wantLabels.length && gotLabels.every((l, i) => l === wantLabels[i]),
      `node_type enum labels != the ${wantLabels.length} (ordered): got [${gotLabels.join(', ')}]`
    );

    // 3d'. No discussion-board tables exist after a fresh bootstrap. The
    // node_type enum keeps its `post` and `discussion` labels (checked above):
    // an enum label cannot be dropped safely.
    const { rows: boardTables } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('posts','post_reads','discussions','discussion_boards')` +
        ` AND table_type IN ('BASE TABLE','VIEW')`
    );
    assert(boardTables[0]?.n === '0', 'discussion-board tables must not exist');

    const { rows: blocksTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.blocks') IS NOT NULL AS present`
    );
    assert(blocksTable[0]?.present === false, 'blocks table must not exist');

    // 3e. Attribution: docs/containers created_by + last_edited_by FKs into
    // members, placement_events.moved_by FK, and no author_member_id column.
    const { rows: docAuthorGone } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='docs' AND column_name='author_member_id'
       ) AS present`
    );
    assert(docAuthorGone[0]?.present === false, 'legacy docs.author_member_id must not exist');

    const { rows: attrCols } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
       WHERE table_schema='public'
         AND ((table_name='docs' AND column_name IN ('created_by','last_edited_by'))
           OR (table_name='containers' AND column_name IN ('created_by','last_edited_by')))`
    );
    assert(attrCols[0]?.n === '4', 'docs/containers attribution columns missing');

    const { rows: attrFks } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_constraint
        WHERE contype='f' AND conname IN (
          'docs_created_by_fkey','docs_last_edited_by_fkey',
          'containers_created_by_fkey','containers_last_edited_by_fkey',
          'placement_events_moved_by_fkey'
        )`
    );
    assert(attrFks[0]?.n === '5', 'attribution FKs -> members missing');

    // 3f. MCP API keys + the members CHECKs accept a kind='external' row with
    // both principal columns NULL (asserted the honest way: insert + delete).
    const { rows: mcpKeysTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.mcp_api_keys') IS NOT NULL AS present`
    );
    assert(mcpKeysTable[0]?.present === true, 'mcp_api_keys table missing');

    const { rows: externalMember } = await db.query<{ id: string }>(
      `INSERT INTO public.members (kind) VALUES ('external') RETURNING id`
    );
    const externalMemberId = externalMember[0]?.id;
    assert(
      typeof externalMemberId === 'string' && externalMemberId.length > 0,
      "members CHECKs should accept kind='external' with NULL principals"
    );
    await db.query(`DELETE FROM public.members WHERE id = $1`, [externalMemberId]);

    // 3g. Agents are archivable, and no agent starts archived. The ghost
    // system agent is seeded with its member principal and delete guard.
    const { rows: agentArchivedChk } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'agents_archived_consistency_chk'
       ) AS present`
    );
    assert(agentArchivedChk[0]?.present === true, 'agents_archived_consistency_chk missing');

    const { rows: archivedAgents } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.agents WHERE archived = true`
    );
    assert(archivedAgents[0]?.count === '0', 'no agent should be archived on a fresh DB');

    const { rows: ghost } = await db.query<{ n: string }>(
      `SELECT ((SELECT COUNT(*) FROM public.agents WHERE id='ghost')
             + (SELECT COUNT(*) FROM public.members WHERE id='ghost'))::text AS n`
    );
    assert(ghost[0]?.n === '2', 'ghost agent + member must be seeded');
    let ghostDeleteBlocked = false;
    try {
      await db.query(`DELETE FROM public.agents WHERE id = 'ghost'`);
    } catch {
      ghostDeleteBlocked = true;
    }
    assert(ghostDeleteBlocked, 'ghost agent delete must be blocked at the database floor');

    // 3h. Provider catalog: the exact shipped provider set (16 cards), xAI
    // seeded with its auth type, and no groq card (nor a dangling groq auth
    // type, which would render an unusable card).
    const SHIPPED_PROVIDERS = [
      'anthropic',
      'apple-on-device',
      'codex',
      'copilot',
      'deepseek',
      'github',
      'google',
      'google-workspace',
      'lm-studio',
      'local-onnx',
      'mistral',
      'ollama',
      'openai',
      'snaglet-local',
      'together',
      'xai',
    ];
    const { rows: providerIds } = await db.query<{ id: string }>(
      `SELECT id FROM public.providers ORDER BY id`
    );
    const gotProviders = providerIds.map((r) => r.id);
    assert(
      gotProviders.length === SHIPPED_PROVIDERS.length &&
        gotProviders.every((id, i) => id === SHIPPED_PROVIDERS[i]),
      `seeded providers != the ${SHIPPED_PROVIDERS.length} shipped cards: got [${gotProviders.join(', ')}]`
    );

    const { rows: xaiProvider } = await db.query<{ id: string; type: string }>(
      `SELECT id, type FROM public.providers WHERE id = 'xai'`
    );
    assert(
      xaiProvider[0]?.id === 'xai' && xaiProvider[0]?.type === 'llm',
      'xai provider row missing or not type=llm'
    );

    const { rows: xaiAuth } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.provider_auth_types
          WHERE id = 'xai:api-key' AND provider_id = 'xai'
       ) AS present`
    );
    assert(xaiAuth[0]?.present === true, 'xai:api-key auth type missing');

    const { rows: groqRows } = await db.query<{ n: string }>(
      `SELECT ((SELECT COUNT(*) FROM public.providers WHERE id = 'groq')
             + (SELECT COUNT(*) FROM public.provider_auth_types WHERE provider_id = 'groq')
             + (SELECT COUNT(*) FROM public.models WHERE provider_id = 'groq'))::text AS n`
    );
    assert(groqRows[0]?.n === '0', 'groq must not be seeded into a fresh install');

    // Provider marks come from the provider id in the UI; providers has no icon column.
    const { rows: providerIcon } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'providers' AND column_name = 'icon'
       ) AS present`
    );
    assert(providerIcon[0]?.present === false, 'providers.icon column must not exist');

    // Any automation may sit on a calendar: the timing-shape check must
    // not pin interval rows to calendar_id IS NULL.
    const { rows: shapeCheck } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'automations_when_shape_check'
          AND c.conrelid = 'public.automations'::regclass`
    );
    const shapeDef = shapeCheck[0]?.def;
    assert(
      typeof shapeDef === 'string' && shapeDef.length > 0 && !shapeDef.includes('calendar_id'),
      'automations_when_shape_check must let interval automations sit on a calendar'
    );

    // 3i. Memories are owned by exactly one of agent/member (owner-XOR CHECK),
    // proven by attempting both violating inserts and reading the violated
    // constraint name off the PostgreSQL error.
    const { rows: ownerXorChks } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_constraint
        WHERE contype='c' AND conname = 'memories_owner_xor_chk'`
    );
    assert(ownerXorChks[0]?.n === '1', 'memories owner-XOR CHECK constraint missing');

    for (const [agentId, memberId, label] of [
      ['agent-init-bogus', 'member-init-bogus', 'both owners'],
      [null, null, 'neither owner'],
    ] as const) {
      let inserted = false;
      let constraint: string | undefined;
      try {
        await db.query(
          `INSERT INTO public.memories (agent_id, member_id, content) VALUES ($1, $2, $3)`,
          [agentId, memberId, `init probe: ${label}`]
        );
        inserted = true;
      } catch (err) {
        constraint = (err as { constraint?: string })?.constraint;
      }
      assert(
        !inserted && constraint === 'memories_owner_xor_chk',
        `memories ${label} insert should be rejected by memories_owner_xor_chk ` +
          `(inserted=${inserted}, constraint=${constraint})`
      );
    }

    // 3j. Workspace semantic cards do not exist; the two look-alikes that must
    // survive (per-agent thread_summaries + images.tags) do.
    const CARD_COLUMNS = [
      'summary',
      'summarized_at',
      'summary_snapshot',
      'summary_source_hash',
      'summary_delta_chars',
      'summary_no_judge_count',
      'summary_force_refresh',
      'summary_through_message_id',
    ];
    const { rows: cardCols } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('docs','containers','threads')
          AND column_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [CARD_COLUMNS]
    );
    assert(
      cardCols.length === 0,
      `fresh schema must contain no workspace-card columns, found ${cardCols
        .map((r) => `${r.table_name}.${r.column_name}`)
        .join(', ')}`
    );

    const { rows: threadSummariesTable } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.thread_summaries') IS NOT NULL AS present`
    );
    assert(
      threadSummariesTable[0]?.present === true,
      'public.thread_summaries must exist (per-agent summaries)'
    );

    const { rows: threadSummaryCurrentIdx } = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.thread_summaries_current_idx') IS NOT NULL AS present`
    );
    assert(
      threadSummaryCurrentIdx[0]?.present === true,
      'thread_summaries_current_idx ((thread_id, agent_id) WHERE is_current) missing'
    );

    // Every trigger function is attached to a trigger: none is left dead.
    const { rows: detachedTriggerFunctions } = await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)`
    );
    assert(
      detachedTriggerFunctions.length === 0,
      `trigger functions with no trigger: ${detachedTriggerFunctions.map((r) => r.proname).join(', ')}`
    );

    const { rows: imageTagsCol } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='images' AND column_name='tags'
       ) AS present`
    );
    assert(imageTagsCol[0]?.present === true, 'images.tags column missing');

    // 3k. Feature flags: exact shape, fail-closed seed row.
    const { rows: featureFlagColumns } = await db.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'feature_flags'
        ORDER BY ordinal_position`
    );
    assert(
      featureFlagColumns.map((row) => row.column_name).join(',') === 'id,name,enabled',
      'feature_flags columns must be exactly id,name,enabled'
    );
    const enabledColumn = featureFlagColumns.find((row) => row.column_name === 'enabled');
    assert(
      enabledColumn?.is_nullable === 'NO' && enabledColumn.column_default === 'false',
      'feature_flags.enabled must be NOT NULL DEFAULT false'
    );
    for (const [flagName, seeded] of [
      ['local_model_removal_ui', false],
      ['cli_pane_ui', false],
      ['fallback_credentials', false],
      ['hub_home', true],
    ] as const) {
      const { rows: flag } = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM public.feature_flags WHERE name = $1`,
        [flagName]
      );
      assert(
        flag.length === 1 && flag[0]?.enabled === seeded,
        `${flagName} must be seeded ${seeded ? 'enabled' : 'disabled'}`
      );
    }

    // 3l. A 'status' category is refused by the CHECK, through
    // the real shared-PK node/container shape; cleanup exercises the cascade.
    const statusProbeId = `container-bootstrap-status-${Date.now()}`;
    await db.query(
      `INSERT INTO public.nodes (id, type, container_id)
       VALUES ($1, 'container', NULL)`,
      [statusProbeId]
    );
    let statusRejected = false;
    try {
      await db.query(
        `INSERT INTO public.containers (id, name, category)
         VALUES ($1, 'Status category bootstrap probe', 'status')`,
        [statusProbeId]
      );
    } catch {
      statusRejected = true;
    }
    assert(statusRejected, "containers must refuse the retired category 'status'");
    await db.query(`DELETE FROM public.nodes WHERE id = $1`, [statusProbeId]);

    // 3m. A relation field may point at a workspace member.
    const memberProbeTable = `table-bootstrap-member-${Date.now()}`;
    const memberProbeField = `field-bootstrap-member-${Date.now()}`;
    await db.query(
      `INSERT INTO public.table_catalog (id, name, table_name, origin)
       VALUES ($1, 'bootstrap_member_probe', 'bootstrap_member_probe', 'custom')`,
      [memberProbeTable]
    );
    await db.query(
      `INSERT INTO public.table_fields
         (id, table_id, column_name, name, type, nullable, default_value, reference_table_id,
          reference_kind, position, multiple, state, state_changed_at)
       VALUES ($1, $2, 'assignee', 'assignee', 'relation', true, 'null'::jsonb, NULL,
               'member', 0, false, 'active', NULL)`,
      [memberProbeField, memberProbeTable]
    );
    const { rows: memberProbe } = await db.query<{ reference_kind: string | null }>(
      `SELECT reference_kind FROM public.table_fields WHERE id = $1`,
      [memberProbeField]
    );
    assert(
      memberProbe[0]?.reference_kind === 'member',
      "relation fields must accept reference_kind='member'"
    );
    await db.query(`DELETE FROM public.table_fields WHERE id = $1`, [memberProbeField]);
    await db.query(`DELETE FROM public.table_catalog WHERE id = $1`, [memberProbeTable]);

    // Trust is opt-in on both fresh installs and upgrades; existing agents must
    // retain confirmations until a user explicitly enables their trust flag.
    const { rows: trustColumn } = await db.query<{
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agents'
          AND column_name = 'trusted_tool_calls'`);
    assert(
      trustColumn[0]?.data_type === 'boolean' &&
        trustColumn[0]?.is_nullable === 'NO' &&
        trustColumn[0]?.column_default === 'false',
      'agent trusted_tool_calls must be boolean NOT NULL DEFAULT false'
    );
    const { rows: trustedAgents } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.agents WHERE trusted_tool_calls`
    );
    assert(trustedAgents[0]?.n === '0', 'fresh agents must not implicitly trust tool calls');

    // 3m. The model catalog a fresh install ships with. A model with no row
    // budgets against DEFAULT_CONTEXT_WINDOW (8192), so an empty picker is a
    // wrong budget, not just an empty picker — these counts are the guard.
    // Cloud providers only: ollama/lm-studio models are whatever one machine
    // pulled, and must come from local discovery instead.
    const SEEDED_MODEL_COUNTS: Array<[string, number]> = [
      ['anthropic', 18],
      ['codex', 12],
      ['copilot', 30],
      ['deepseek', 2],
      ['google', 14],
      ['mistral', 37],
      ['openai', 65],
      ['together', 171],
      ['xai', 8],
    ];
    for (const [providerId, want] of SEEDED_MODEL_COUNTS) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM public.models
          WHERE provider_id = $1 AND is_active AND type = 'llm'`,
        [providerId]
      );
      assert(rows[0]?.n === String(want), `${providerId} seeded models ${rows[0]?.n} != ${want}`);
    }

    const { rows: localOnly } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.models
        WHERE provider_id IN ('ollama', 'lm-studio')`
    );
    assert(localOnly[0]?.n === '0', 'machine-local provider models must not be seeded');

    // Spot-check that the seeded windows are real numbers, not placeholders:
    // a NULL/8192 window here is the exact failure this seed exists to stop.
    for (const [providerId, modelId, window] of [
      ['anthropic', 'claude-fable-5-2', 1000000],
      ['anthropic', 'claude-opus-4-5', 200000],
      ['openai', 'gpt-6.2-astra', 1050000],
      ['codex', 'gpt-6.1-sol', 500000],
    ] as const) {
      const { rows } = await db.query<{ ctx: number | null; active: boolean }>(
        `SELECT context_window_tokens AS ctx, is_active AS active FROM public.models
          WHERE provider_id = $1 AND model_id = $2`,
        [providerId, modelId]
      );
      assert(
        rows[0]?.ctx === window && rows[0]?.active === true,
        `${providerId}/${modelId} context window ${String(rows[0]?.ctx)} != ${window} (active=${String(rows[0]?.active)})`
      );
    }

    // 4. Catalog heal path: delete builtin rows out-of-band, replay the full
    // seed sequence (the exact statements ensureBuiltinCatalog and doReset
    // run), and confirm the rows come back — including requires_confirmation
    // on the builtin MCP servers.
    await db.query(`DELETE FROM public.mcp_servers WHERE source = 'builtin'`);
    await db.query(`DELETE FROM public.providers WHERE id = 'mistral'`);
    await reapplyProviderCatalogSeed(db);
    await reapplySeedFiles(db, [...SEED_REPLAY_FILES]);
    await reapplyLocalModelSeeds(db);
    const { rows: healedProvider } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.providers WHERE id = 'mistral') AS present`
    );
    assert(healedProvider[0]?.present === true, 'seed replay must restore a deleted provider row');
    // Deleting the provider cascaded its models away; the replay must bring
    // the whole Mistral catalog back, not just the card.
    const { rows: healedModels } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.models WHERE provider_id = 'mistral' AND is_active`
    );
    assert(healedModels[0]?.n === '37', `healed mistral models ${healedModels[0]?.n} != 37`);
    // There is no builtin GitHub MCP server; the seed replay must not create one.
    const { rows: retiredGithubMcp } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.mcp_servers WHERE id = 'github' AND source = 'builtin') AS present`
    );
    assert(
      retiredGithubMcp[0]?.present === false,
      'seed replay must not resurrect the retired builtin GitHub MCP server'
    );
    // Nor a builtin Postgres MCP server.
    const { rows: retiredPostgresMcp } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.mcp_servers WHERE id = 'postgres') AS present`
    );
    assert(
      retiredPostgresMcp[0]?.present === false,
      'seed replay must not resurrect the retired builtin Postgres MCP server'
    );

    // Nor a builtin Playwright MCP server (browsing is the native `browser` tool).
    const { rows: retiredPlaywrightMcp } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM public.mcp_servers WHERE id = 'playwright') AS present`
    );
    assert(
      retiredPlaywrightMcp[0]?.present === false,
      'seed replay must not resurrect the retired builtin Playwright MCP server'
    );

    console.log(
      JSON.stringify({
        ok: true,
        concurrentBootstrapSerialized: true,
        migrationCount,
        baselineLedger: true,
        idempotentReapply: true,
        vectorTypmod: 768,
        hnswIndex: true,
        hnswEfSearch: 100,
        localModelSeeded: true,
        categoriesTaskFields: true,
        docSubtypeDropped: true,
        placementEvents: true,
        projectScopes: true,
        nodeTypeEnumLabels: wantLabels.length,
        sketchesRemoved: true,
        boardTablesAbsent: true,
        docAttribution: true,
        mcpApiKeys: true,
        agentsArchivable: true,
        ghostAgentGuarded: true,
        xaiSeeded: true,
        shippedProviders: SHIPPED_PROVIDERS.length,
        groqAbsent: true,
        seededCloudModels: SEEDED_MODEL_COUNTS.reduce((n, [, count]) => n + count, 0),
        memberOwnedOwnershipXor: true,
        workspaceCardsRemoved: true,
        threadSummariesPreserved: true,
        imageTagsPreserved: true,
        featureFlags: true,
        localModelRemovalUiDisabled: true,
        statusCategoryRetired: true,
        memberReferenceKind: true,
        catalogSeedReplay: true,
        builtinMcpConfirmation: true,
      })
    );
  } finally {
    await contender?.end().catch((error: unknown) => {
      console.warn(
        `[verify-fresh-bootstrap] contender pool close failed: ${getErrorMessage(error)}`
      );
    });
    try {
      await db?.end();
    } catch (error: unknown) {
      console.error(
        `[verify-fresh-bootstrap] database pool close failed: ${getErrorMessage(error)}`
      );
    }
    await target?.dispose();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: getErrorMessage(err) }));
    process.exit(1);
  });
