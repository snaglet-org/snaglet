-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- The built-in Database tables: Snaglet's own `public` tables, listed in
-- `public.table_catalog` under stable `table-builtin-*` ids. Only builtin rows
-- are touched; custom (user-created) rows are never read or rewritten here.

INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES
  ('table-builtin-docs', 'Docs', 'docs', 'builtin'),
  ('table-builtin-containers', 'Containers', 'containers', 'builtin'),
  ('table-builtin-hooks', 'Hooks', 'hook_registrations', 'builtin'),
  ('table-builtin-tools', 'Tools', 'tools', 'builtin'),
  ('table-builtin-files', 'Files', 'files', 'builtin'),
  ('table-builtin-images', 'Images', 'images', 'builtin'),
  ('table-builtin-threads', 'Threads', 'threads', 'builtin'),
  ('table-builtin-agents', 'Agents', 'agents', 'builtin'),
  ('table-builtin-providers', 'Providers', 'providers', 'builtin'),
  ('table-builtin-models', 'Models', 'models', 'builtin'),
  ('table-builtin-credentials', 'Credentials', 'user_provider_credentials', 'builtin')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      table_name = EXCLUDED.table_name
  WHERE public.table_catalog.origin = 'builtin';

-- Automations. Its own statement: an active custom table may already
-- hold the name, and the names are unique, so it is added only while free.
INSERT INTO public.table_catalog (id, name, table_name, origin)
SELECT 'table-builtin-automations', 'Automations', 'automations', 'builtin'
 WHERE to_regclass('public.automations') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.table_catalog
      WHERE lower(name) = 'automations' AND state = 'active'
        AND id <> 'table-builtin-automations'
   )
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      table_name = EXCLUDED.table_name
  WHERE public.table_catalog.origin = 'builtin';
