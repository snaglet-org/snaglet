-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- The snaglet-local runtime provider card. Its reranker model row is in
-- local-models.sql.

INSERT INTO public.providers (
  id,
  name,
  description,
  website,
  api_docs,
  sort_order,
  default_metadata,
  base_url,
  type
) VALUES (
  'snaglet-local',
  'Snaglet Local Runtime',
  'Local runtime assets managed by Snaglet, starting with the built-in MiniLM reranker for context curation.',
  NULL,
  NULL,
  11,
  '{}'::jsonb,
  NULL,
  'runtime'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  default_metadata = EXCLUDED.default_metadata,
  base_url = EXCLUDED.base_url,
  type = EXCLUDED.type,
  updated_at = NOW();
