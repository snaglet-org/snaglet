-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- The permanent "ghost" system agent + its member principal. When an agent is
-- permanently deleted, every kept reference (messages, runs, activity log,
-- workspace attribution) is repointed to ghost so history never goes
-- authorless. The schema's BEFORE DELETE trigger
-- (`agents_block_ghost_delete_trg`) makes the ghost row undeletable.

INSERT INTO public.agents (id, name, role)
VALUES ('ghost', 'ghost', 'System')
ON CONFLICT DO NOTHING;

-- Ghost's principal identity row. kind='agent' with agent_id set satisfies
-- members_principal_match; the agent_id FK resolves to the row seeded above.
-- Bare ON CONFLICT DO NOTHING absorbs a conflict on the id PK or the
-- members_unique_agent partial index (a member already existing for ghost).
INSERT INTO public.members (id, kind, agent_id)
VALUES ('ghost', 'agent', 'ghost')
ON CONFLICT DO NOTHING;
