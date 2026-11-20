-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- The cloud provider model catalogs: which models each hosted provider offers,
-- with the context windows and output limits it publishes. Runs last, after
-- every provider card exists (provider-catalog.sql, provider-deepseek.sql,
-- provider-xai.sql), so each row's provider_id FK resolves.
--
-- Why it exists. `contextWindow/budget.ts` uses DEFAULT_CONTEXT_WINDOW (8192)
-- for a model with no catalog row or no window, which leaves an agent about
-- 2.6k tokens of message budget. Discovery writes the catalog only when a
-- credential is saved or tested, so these rows are the floor until then.
--
-- What is in. Nine hosted providers whose model lists are the same for every
-- user: anthropic, openai, codex, copilot, google, mistral, together, xai,
-- deepseek. A limit the provider does not publish is NULL: a NULL max output
-- lets the provider apply its own maximum, and the Codex rows with a NULL
-- window (gpt-6-astra, gpt-6-luna, gpt-6.1-terra) take the default window
-- until discovery or a person sets one.
--
-- What is left out.
--   - `ollama` and `lm-studio`: their models are whatever one machine has
--     installed, so they come from local discovery.
--   - The bundled local runtimes (`snaglet-local`, `local-onnx`,
--     `apple-on-device`): seeded by local-models.sql /
--     provider-snaglet-local.sql / provider-apple-on-device.sql against files
--     the app ships.
--   - Inactive rows: a row is inactive when a person removed it or one
--     account's plan blocks it, so it does not apply to every user.
--
-- `metadata` is `{}`, `{"lifecycle": "deprecated"}` for a model the provider
-- has scheduled for retirement, or `{"lifecycle": "legacy"}` for an older
-- model it still serves. Pickers list deprecated and legacy models after the
-- current ones, and the default suggestion skips them.
--
-- No-resurrect contract. Every statement here is INSERT ... ON CONFLICT DO
-- NOTHING with no conflict target, i.e. strict insert-if-absent: a conflict on
-- either unique constraint (the `id` primary key or `(provider_id, model_id)`)
-- skips the row. Nothing here UPDATEs a models row. Removing a model from the
-- picker is a soft delete: `Models.deactivateByUser` sets `is_active = FALSE`
-- and stamps `metadata.deactivatedBy = 'user'`, and the row stays. An
-- `ON CONFLICT ... DO UPDATE` (what `Models.bulkUpsert` does, which is why
-- `ProviderModelDiscoveryService/persistence.ts` uses it for new rows only)
-- would set `is_active` back to TRUE and drop the stamp, bringing back on
-- every boot the models a person removed. `is_active` is therefore absent from
-- the column list: new rows take the column DEFAULT (TRUE), and existing rows
-- are never touched.
--
-- `id` is the deterministic `<provider_id>:<model_id>`, so replays are stable
-- and a diff of this file reads as model names rather than UUID churn.

-- Anthropic — the Claude family. (18 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('anthropic:claude-opus-4-5', 'anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', 'Most capable Claude model — best for complex reasoning and coding.', NULL, 200000, 64000, true, false, false, 'llm', NULL, 0, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-7', 'anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 'Anthropic''s most capable model', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 0, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-6', 'anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 1, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 'Balanced speed and intelligence. Best for most tasks.', NULL, 200000, 16000, true, false, false, 'llm', NULL, 1, '{"lifecycle": "deprecated"}'::jsonb),
  ('anthropic:claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '', 'claude-sonnet', 1000000, 128000, true, true, false, 'llm', NULL, 2, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '', NULL, 200000, 64000, true, false, false, 'llm', NULL, 5, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-fable-5', 'anthropic', 'claude-fable-5', 'Claude Fable 5', '', 'claude', 1000000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', '', 'claude', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-fable-5-2', 'anthropic', 'claude-fable-5-2', 'Claude Fable 5.2', '', 'claude', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-haiku-4-5-20251001', 'anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '', 'claude-haiku', 200000, 64000, true, true, false, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', '', 'claude-haiku', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-opus-4-5-20251101', 'anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', '', 'claude-opus', 200000, 64000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-8', 'anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-5', 'anthropic', 'claude-opus-5', 'Claude Opus 5', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-sonnet-4-5-20250929', 'anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', '', 'claude-sonnet', 200000, 16000, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('anthropic:claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', '', 'claude-sonnet', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '', 'claude-sonnet', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- OpenAI — GPT / o-series. (65 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('openai:gpt-4o', 'openai', 'gpt-4o', 'GPT-4o', 'Flagship multimodal model — text, vision, and audio.', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('openai:gpt-4o-mini', 'openai', 'gpt-4o-mini', 'GPT-4o Mini', 'Affordable and fast GPT-4o variant for lightweight tasks.', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 1, '{}'::jsonb),
  ('openai:chat-latest', 'openai', 'chat-latest', 'Chat Latest', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1', 'openai', 'gpt-4.1', 'GPT-4.1', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1-2025-04-14', 'openai', 'gpt-4.1-2025-04-14', 'GPT-4.1', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4.1-mini', 'openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1-mini-2025-04-14', 'openai', 'gpt-4.1-mini-2025-04-14', 'GPT-4.1 Mini', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-05-13', 'openai', 'gpt-4o-2024-05-13', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-08-06', 'openai', 'gpt-4o-2024-08-06', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-11-20', 'openai', 'gpt-4o-2024-11-20', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-mini-2024-07-18', 'openai', 'gpt-4o-mini-2024-07-18', 'GPT-4o Mini', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-mini-tts', 'openai', 'gpt-4o-mini-tts', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4o-mini-tts-2025-03-20', 'openai', 'gpt-4o-mini-tts-2025-03-20', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4o-mini-tts-2025-12-15', 'openai', 'gpt-4o-mini-tts-2025-12-15', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5', 'openai', 'gpt-5', 'GPT-5', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-2025-08-07', 'openai', 'gpt-5-2025-08-07', 'GPT-5', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-mini', 'openai', 'gpt-5-mini', 'GPT-5 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-mini-2025-08-07', 'openai', 'gpt-5-mini-2025-08-07', 'GPT-5 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-nano', 'openai', 'gpt-5-nano', 'GPT-5 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-nano-2025-08-07', 'openai', 'gpt-5-nano-2025-08-07', 'GPT-5 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-pro', 'openai', 'gpt-5-pro', 'GPT-5 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-pro-2025-10-06', 'openai', 'gpt-5-pro-2025-10-06', 'GPT-5 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-search-api', 'openai', 'gpt-5-search-api', 'GPT-5 Search Api', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5-search-api-2025-10-14', 'openai', 'gpt-5-search-api-2025-10-14', 'GPT-5 Search Api', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.1', 'openai', 'gpt-5.1', 'GPT-5.1', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.1-2025-11-13', 'openai', 'gpt-5.1-2025-11-13', 'GPT-5.1', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.2', 'openai', 'gpt-5.2', 'GPT-5.2', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-2025-12-11', 'openai', 'gpt-5.2-2025-12-11', 'GPT-5.2', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-pro', 'openai', 'gpt-5.2-pro', 'GPT-5.2 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-pro-2025-12-11', 'openai', 'gpt-5.2-pro-2025-12-11', 'GPT-5.2 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.3-codex', 'openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4', 'openai', 'gpt-5.4', 'GPT-5.4', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-2026-03-05', 'openai', 'gpt-5.4-2026-03-05', 'GPT-5.4', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-mini', 'openai', 'gpt-5.4-mini', 'GPT-5.4 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-mini-2026-03-17', 'openai', 'gpt-5.4-mini-2026-03-17', 'GPT-5.4 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-nano', 'openai', 'gpt-5.4-nano', 'GPT-5.4 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4-nano-2026-03-17', 'openai', 'gpt-5.4-nano-2026-03-17', 'GPT-5.4 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4-pro', 'openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-pro-2026-03-05', 'openai', 'gpt-5.4-pro-2026-03-05', 'GPT-5.4 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5', 'openai', 'gpt-5.5', 'GPT-5.5', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-2026-04-23', 'openai', 'gpt-5.5-2026-04-23', 'GPT-5.5', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-pro', 'openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-pro-2026-04-23', 'openai', 'gpt-5.5-pro-2026-04-23', 'GPT-5.5 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-luna', 'openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-sol', 'openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-astra', 'openai', 'gpt-6-astra', 'GPT-6 Astra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-luna', 'openai', 'gpt-6-luna', 'GPT-6 Luna', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-sol', 'openai', 'gpt-6-sol', 'GPT-6 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.1-terra', 'openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.2-astra', 'openai', 'gpt-6.2-astra', 'GPT-6.2 Astra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.2-sol', 'openai', 'gpt-6.2-sol', 'GPT-6.2 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio', 'openai', 'gpt-audio', 'GPT Audio', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-1.5', 'openai', 'gpt-audio-1.5', 'GPT Audio 1.5', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-2025-08-28', 'openai', 'gpt-audio-2025-08-28', 'GPT Audio', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini', 'openai', 'gpt-audio-mini', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini-2025-10-06', 'openai', 'gpt-audio-mini-2025-10-06', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini-2025-12-15', 'openai', 'gpt-audio-mini-2025-12-15', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-oss-120b', 'openai', 'gpt-oss-120b', 'GPT-OSS 120B', '', 'gpt-oss', 131072, 131072, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-oss-20b', 'openai', 'gpt-oss-20b', 'GPT-OSS 20B', '', 'gpt-oss', 131072, 131072, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:o3', 'openai', 'o3', 'o3', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-2025-04-16', 'openai', 'o3-2025-04-16', 'o3', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-pro', 'openai', 'o3-pro', 'o3 Pro', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-pro-2025-06-10', 'openai', 'o3-pro-2025-06-10', 'o3 Pro', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb)
ON CONFLICT DO NOTHING;

-- OpenAI Codex — the coding-focused slice of OpenAI's catalog. (12 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('codex:gpt-6-astra', 'codex', 'gpt-6-astra', 'GPT-6 Astra', 'Complex reasoning and coding; standard Codex context window', 'gpt-6', NULL, 128000, true, true, true, 'llm', NULL, -1, '{}'::jsonb),
  ('codex:gpt-6.1-sol', 'codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'Coding and everyday work; standard Codex context window', 'gpt-6', 500000, 128000, true, true, true, 'llm', NULL, -1, '{}'::jsonb),
  ('codex:gpt-5.3-codex', 'codex', 'gpt-5.3-codex', 'GPT-5.3 Codex', 'Core Codex model', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 3, '{"lifecycle": "deprecated"}'::jsonb),
  ('codex:gpt-5.2', 'codex', 'gpt-5.2', 'GPT-5.2', 'Core Codex model', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 5, '{"lifecycle": "deprecated"}'::jsonb),
  ('codex:codex-latest', 'codex', 'codex-latest', 'Codex Latest (rolling)', 'Rolling alias for latest Codex model', 'alias', 400000, 128000, true, true, true, 'llm', NULL, 9, '{}'::jsonb),
  ('codex:gpt-5.6-luna', 'codex', 'gpt-5.6-luna', 'gpt-5.6-luna', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-5.6-sol', 'codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-5.6-terra', 'codex', 'gpt-5.6-terra', 'GPT 5.6 Terra', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6-luna', 'codex', 'gpt-6-luna', 'GPT-6 Luna', '', 'gpt-6', NULL, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.1-terra', 'codex', 'gpt-6.1-terra', 'GPT-6.1 Terra', '', 'gpt-6', NULL, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.2-astra', 'codex', 'gpt-6.2-astra', 'GPT-6.2 Astra', '', 'gpt-6', 272000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.2-sol', 'codex', 'gpt-6.2-sol', 'GPT-6.2 Sol', '', 'gpt-6', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- GitHub Copilot — multi-vendor models fronted by the Copilot API. (30 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('copilot:gpt-4.1', 'copilot', 'gpt-4.1', 'GPT-4.1', 'General-purpose coding and writing', 'gpt-4', 1047576, 32768, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('copilot:gpt-4o', 'copilot', 'gpt-4o', 'GPT-4o', 'OpenAI GPT-4o via Copilot', 'gpt-4o', 128000, NULL, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('copilot:gpt-4o-mini', 'copilot', 'gpt-4o-mini', 'GPT-4o mini', 'OpenAI GPT-4o mini via Copilot', 'gpt-4o', 128000, NULL, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('copilot:gpt-5-mini', 'copilot', 'gpt-5-mini', 'GPT-5 mini', 'Reliable default for coding, writing, and multimodal', 'gpt-5-mini', 264000, 64000, true, true, false, 'llm', NULL, 1, '{}'::jsonb),
  ('copilot:gpt-5.3-codex', 'copilot', 'gpt-5.3-codex', 'GPT-5.3-Codex', 'Agentic software development', 'gpt-5.3-codex', 400000, 128000, true, true, false, 'llm', NULL, 5, '{}'::jsonb),
  ('copilot:gpt-5.4', 'copilot', 'gpt-5.4', 'GPT-5.4', 'Complex reasoning, code analysis, and technical decisions', 'gpt-5.4', 400000, 128000, true, true, false, 'llm', NULL, 6, '{}'::jsonb),
  ('copilot:gpt-5.4-mini', 'copilot', 'gpt-5.4-mini', 'GPT-5.4 mini', 'Codebase exploration, grep-style tools', 'gpt-5.4-mini', 400000, 128000, true, true, false, 'llm', NULL, 7, '{}'::jsonb),
  ('copilot:claude-haiku-4.5', 'copilot', 'claude-haiku-4.5', 'Claude Haiku 4.5', 'Fast, reliable answers to lightweight coding questions', 'claude-haiku-4.5', 200000, 32000, true, true, false, 'llm', NULL, 10, '{}'::jsonb),
  ('copilot:claude-opus-4.5', 'copilot', 'claude-opus-4.5', 'Claude Opus 4.5', 'Complex problem-solving, sophisticated reasoning', 'claude-opus-4.5', 200000, 32000, true, true, false, 'llm', NULL, 11, '{}'::jsonb),
  ('copilot:claude-opus-4.6', 'copilot', 'claude-opus-4.6', 'Claude Opus 4.6', 'Anthropic''s most powerful model, improves on Opus 4.5', 'claude', 200000, 16000, true, true, true, 'llm', NULL, 12, '{}'::jsonb),
  ('copilot:claude-opus-4.6-fast', 'copilot', 'claude-opus-4.6-fast', 'Claude Opus 4.6 (fast mode)', 'Opus 4.6 fast mode preview — 30x multiplier', 'claude', 200000, 16000, true, true, true, 'llm', NULL, 13, '{}'::jsonb),
  ('copilot:claude-sonnet-4.5', 'copilot', 'claude-sonnet-4.5', 'Claude Sonnet 4.5', 'Complex problem-solving, sophisticated reasoning', 'claude-sonnet-4.5', 200000, 32000, true, true, false, 'llm', NULL, 15, '{}'::jsonb),
  ('copilot:claude-sonnet-4.6', 'copilot', 'claude-sonnet-4.6', 'Claude Sonnet 4.6', 'Reliable completions and smarter reasoning under pressure', 'claude-sonnet-4.6', 264000, 64000, true, true, false, 'llm', NULL, 16, '{}'::jsonb),
  ('copilot:gemini-2.5-pro', 'copilot', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'Complex code generation, debugging, and research', 'gemini-2.5-pro', 128000, 64000, true, true, false, 'llm', NULL, 20, '{}'::jsonb),
  ('copilot:Grok-3', 'copilot', 'Grok-3', 'Grok 3', 'xAI Grok 3 via Copilot', 'grok', 131072, NULL, true, false, false, 'llm', NULL, 21, '{}'::jsonb),
  ('copilot:claude-fable-5', 'copilot', 'claude-fable-5', 'Claude Fable 5', '', 'claude-fable-5', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.7', 'copilot', 'claude-opus-4.7', 'Claude Opus 4.7', '', 'claude-opus-4.7', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.8', 'copilot', 'claude-opus-4.8', 'Claude Opus 4.8', '', 'claude-opus-4.8', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.8-fast', 'copilot', 'claude-opus-4.8-fast', 'Claude Opus 4.8 (fast mode)', '', 'claude-opus-4.8-fast', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-sonnet-5', 'copilot', 'claude-sonnet-5', 'Claude Sonnet 5', '', 'claude-sonnet-5', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3-flash-preview', 'copilot', 'gemini-3-flash-preview', 'Gemini 3 Flash (Preview)', '', 'gemini-3-flash', 128000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3.1-pro-preview', 'copilot', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro', '', 'gemini-3.1-pro-preview', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3.5-flash', 'copilot', 'gemini-3.5-flash', 'Gemini 3.5 Flash', '', 'gemini-3.5-flash', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.5', 'copilot', 'gpt-5.5', 'GPT-5.5', '', 'gpt-5.5', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-luna', 'copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna', '', 'gpt-5.6-luna', 328000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-sol', 'copilot', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', 'gpt-5.6-sol', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-terra', 'copilot', 'gpt-5.6-terra', 'GPT-5.6 Terra', '', 'gpt-5.6-terra', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:kimi-k2.7-code', 'copilot', 'kimi-k2.7-code', 'Kimi K2.7 Code', '', 'kimi-k2.7-code', 256000, 32000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:mai-code-1-flash-picker', 'copilot', 'mai-code-1-flash-picker', 'MAI-Code-1-Flash', '', 'oswe-vscode-modelD', 256000, 128000, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:oswe-vscode-prime', 'copilot', 'oswe-vscode-prime', 'Raptor mini', '', 'oswe-vscode', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Google — Gemini. (14 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('google:gemini-2.0-pro', 'google', 'gemini-2.0-pro', 'Gemini 2.0 Pro', 'Most capable Gemini 2.0 model for complex tasks.', NULL, 2000000, NULL, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('google:gemini-1.5-pro', 'google', 'gemini-1.5-pro', 'Gemini 1.5 Pro', 'Long context model with strong reasoning.', NULL, 2000000, NULL, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('google:gemini-1.5-flash', 'google', 'gemini-1.5-flash', 'Gemini 1.5 Flash', 'Fast and versatile multimodal model.', NULL, 1000000, NULL, true, false, false, 'llm', NULL, 3, '{}'::jsonb),
  ('google:gemini-3-flash-preview', 'google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-flash-lite', 'google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-pro-preview', 'google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-pro-preview-customtools', 'google', 'gemini-3.1-pro-preview-customtools', 'Gemini 3.1 Pro Preview (custom tools)', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.5-flash-lite', 'google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-argon', 'google', 'gemini-4-argon', 'Gemini 4 Argon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-carbon', 'google', 'gemini-4-carbon', 'Gemini 4 Carbon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-hydrogen', 'google', 'gemini-4-hydrogen', 'Gemini 4 Hydrogen', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-neon', 'google', 'gemini-4-neon', 'Gemini 4 Neon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Mistral AI. (37 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('mistral:mistral-large-latest', 'mistral', 'mistral-large-latest', 'Mistral Large 4', 'Official mistral-large-2512 Mistral AI model', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('mistral:open-mistral-7b', 'mistral', 'open-mistral-7b', 'Mistral 7B', 'Lightweight open model for simple tasks', 'mistral-7b', 32768, 4096, true, false, false, 'llm', NULL, 0, '{}'::jsonb),
  ('mistral:open-mixtral-8x7b', 'mistral', 'open-mixtral-8x7b', 'Mixtral 8x7B', 'Open mixture-of-experts model', 'mixtral', 32768, 4096, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('mistral:codestral-latest', 'mistral', 'codestral-latest', 'codestral-2508', 'Our cutting-edge language model for coding released August 2025.', 'codestral', 128000, NULL, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('mistral:open-mixtral-8x22b', 'mistral', 'open-mixtral-8x22b', 'Mixtral 8x22B', 'Most capable open mixture-of-experts model', 'mixtral', 65536, 4096, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('mistral:mistral-small-latest', 'mistral', 'mistral-small-latest', 'mistral-small-2603', 'Mistral Small 4.', 'mistral-small', 262144, 4096, true, true, false, 'llm', NULL, 3, '{}'::jsonb),
  ('mistral:mistral-medium-latest', 'mistral', 'mistral-medium-latest', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral-medium', 131072, 4096, true, true, false, 'llm', NULL, 4, '{"lifecycle": "deprecated"}'::jsonb),
  ('mistral:codestral-2508', 'mistral', 'codestral-2508', 'codestral-2508', 'Our cutting-edge language model for coding released August 2025.', 'codestral', 128000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:deepseek-v4-1-flash-1017', 'mistral', 'deepseek-v4-1-flash-1017', 'DeepSeek V4.1 Flash 1017', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:devstral-latest', 'mistral', 'devstral-latest', 'devstral-2512', 'Official devstral-2512 Mistral AI model', 'mistral', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:devstral-medium-latest', 'mistral', 'devstral-medium-latest', 'devstral-2512', 'Official devstral-2512 Mistral AI model', 'mistral', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:labs-leanstral-2603', 'mistral', 'labs-leanstral-2603', 'labs-leanstral-2603', 'A mid & post-trained version of mistral small 4 for Lean', 'mistral', 196608, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:magistral-medium-latest', 'mistral', 'magistral-medium-latest', 'magistral-medium-2509', 'Our frontier-class reasoning model release candidate September 2025.', 'magistral', 131072, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:magistral-small-latest', 'mistral', 'magistral-small-latest', 'mistral-small-2603', 'Mistral Small 4.', 'magistral', 262144, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-14b-2512', 'mistral', 'ministral-14b-2512', 'ministral-14b-2512', 'Ministral 3 (a.k.a. Tinystral) 14B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-14b-latest', 'mistral', 'ministral-14b-latest', 'ministral-14b-2512', 'Ministral 3 (a.k.a. Tinystral) 14B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-3b-2512', 'mistral', 'ministral-3b-2512', 'ministral-3b-2512', 'Ministral 3 (a.k.a. Tinystral) 3B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-3b-latest', 'mistral', 'ministral-3b-latest', 'ministral-3b-2512', 'Ministral 3 (a.k.a. Tinystral) 3B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-8b-2512', 'mistral', 'ministral-8b-2512', 'ministral-8b-2512', 'Ministral 3 (a.k.a. Tinystral) 8B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-8b-latest', 'mistral', 'ministral-8b-latest', 'ministral-8b-2512', 'Ministral 3 (a.k.a. Tinystral) 8B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-large-2512', 'mistral', 'mistral-large-2512', 'mistral-large-2512', 'Official mistral-large-2512 Mistral AI model', 'mistral-large', 262144, NULL, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('mistral:mistral-large-4', 'mistral', 'mistral-large-4', 'Mistral Large 4', '', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-large-4-0', 'mistral', 'mistral-large-4-0', 'Mistral Large 4', '', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-medium', 'mistral', 'mistral-medium', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral-medium', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-small-2603', 'mistral', 'mistral-small-2603', 'mistral-small-2603', 'Mistral Small 4.', 'mistral-small', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-tiny-2407', 'mistral', 'mistral-tiny-2407', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-tiny-latest', 'mistral', 'mistral-tiny-latest', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-fast', 'mistral', 'mistral-vibe-cli-fast', 'mistral-small-2603', 'Mistral Small 4.', 'mistral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-latest', 'mistral', 'mistral-vibe-cli-latest', 'mistral-medium-3-5', 'Official mistral-medium-3-5 Mistral AI model', 'mistral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-with-tools', 'mistral', 'mistral-vibe-cli-with-tools', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:open-mistral-nemo', 'mistral', 'open-mistral-nemo', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:voxtral-small-2507', 'mistral', 'voxtral-small-2507', 'voxtral-small-2507', 'A small audio understanding model released in July 2025', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:voxtral-small-latest', 'mistral', 'voxtral-small-latest', 'voxtral-small-2507', 'A small audio understanding model released in July 2025', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5', 'mistral', 'zai-glm-5', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5-3', 'mistral', 'zai-glm-5-3', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5-3-flash', 'mistral', 'zai-glm-5-3-flash', 'GLM 5.3 Flash', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-latest', 'mistral', 'zai-glm-latest', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Together AI — hosted open-weight models. (171 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('together:Hcompany/Holo3-35B-A3B', 'together', 'Hcompany/Holo3-35B-A3B', 'Holo3 35B A3b', '', 'hcompany', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:LiquidAI/LFM2-24B-A2B', 'together', 'LiquidAI/LFM2-24B-A2B', 'LFM2-24B-A2B', '', 'togethercomputer', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:LiquidAI/LFM2.5-8B-A1B', 'together', 'LiquidAI/LFM2.5-8B-A1B', 'LFM2.5-8B-A1B', '', 'liquidai', 128000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M1-40k', 'together', 'MiniMaxAI/MiniMax-M1-40k', 'Minimax M1 40K', '', 'minimaxai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M1-80k', 'together', 'MiniMaxAI/MiniMax-M1-80k', 'Minimax M1 80K', '', 'minimaxai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2', 'together', 'MiniMaxAI/MiniMax-M2', 'MiniMax M2', '', 'minimaxai', 196608, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2.5-FP4', 'together', 'MiniMaxAI/MiniMax-M2.5-FP4', 'MiniMax M2.5 FP4', '', 'minimaxai', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2.7', 'together', 'MiniMaxAI/MiniMax-M2.7', 'MiniMax M2.7 FP4', '', 'minimaxai', 196608, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M3', 'together', 'MiniMaxAI/MiniMax-M3', 'MiniMax M3', '', 'minimaxai', 524288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO', 'together', 'NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO', 'Nous Hermes 2 Mixtral 8X7B Dpo', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Prism-ML/Ternary-Bonsai-27B', 'together', 'Prism-ML/Ternary-Bonsai-27B', 'Ternary Bonsai 27B', '', 'prism ml', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/QwQ-32B', 'together', 'Qwen/QwQ-32B', 'Qwen QwQ-32B', '', 'qwq', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-1.5B-Instruct', 'together', 'Qwen/Qwen2-1.5B-Instruct', 'Qwen 2 Instruct (1.5B)', '', 'qwen-2', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-72B-Instruct', 'together', 'Qwen/Qwen2-72B-Instruct', 'Qwen2 72B Instruct', '', 'qwen-2', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-VL-72B-Instruct', 'together', 'Qwen/Qwen2-VL-72B-Instruct', 'Qwen2-VL (72B) Instruct', '', 'qwen-2', 32768, NULL, false, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-1.5B', 'together', 'Qwen/Qwen2.5-1.5B', 'Qwen2.5 1.5B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-1.5B-Instruct', 'together', 'Qwen/Qwen2.5-1.5B-Instruct', 'Qwen2.5 1.5B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-14B', 'together', 'Qwen/Qwen2.5-14B', 'Qwen2.5 14B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-14B-Instruct', 'together', 'Qwen/Qwen2.5-14B-Instruct', 'Qwen 2.5 14B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-32B', 'together', 'Qwen/Qwen2.5-32B', 'Qwen2.5 32B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-32B-Instruct', 'together', 'Qwen/Qwen2.5-32B-Instruct', 'Qwen2.5 32B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-3B-Instruct', 'together', 'Qwen/Qwen2.5-3B-Instruct', 'Qwen2.5 3B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B', 'together', 'Qwen/Qwen2.5-72B', 'Qwen2.5 72B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B-Instruct', 'together', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen2.5 72B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B-Instruct-Turbo', 'together', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'Qwen2.5 72B Instruct Turbo', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B', 'together', 'Qwen/Qwen2.5-7B', 'Qwen2.5 7B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B-Instruct', 'together', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen2.5 7B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B-Instruct-Turbo', 'together', 'Qwen/Qwen2.5-7B-Instruct-Turbo', 'Qwen2.5 7B Instruct Turbo', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-Coder-32B-Instruct', 'together', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'Qwen 2.5 Coder 32B Instruct', '', 'qwen-2.5', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-VL-72B-Instruct', 'together', 'Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen2.5-VL (72B) Instruct', '', 'qwen-2.5', 32768, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-0.6B', 'together', 'Qwen/Qwen3-0.6B', 'Qwen3 0.6B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-1.7B', 'together', 'Qwen/Qwen3-1.7B', 'Qwen3 1.7B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-14B', 'together', 'Qwen/Qwen3-14B', 'Qwen3 14B', '', 'qwen3', 2048, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'together', 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'Qwen3 235B A22b Instruct 2507 Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-235B-A22B-Instruct-2507-tput', 'together', 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', 'Qwen3 235B A22B Instruct 2507 FP8 Throughput', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-30B-A3B', 'together', 'Qwen/Qwen3-30B-A3B', 'Qwen3 30B A3b', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-30B-A3B-Instruct-2507-Lora', 'together', 'Qwen/Qwen3-30B-A3B-Instruct-2507-Lora', 'Qwen3 30B A3B Instruct 2507 Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-32B', 'together', 'Qwen/Qwen3-32B', 'Qwen3 32B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-4B-Instruct-2507', 'together', 'Qwen/Qwen3-4B-Instruct-2507', 'Qwen3 4B Instruct 2507', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-8B', 'together', 'Qwen/Qwen3-8B', 'Qwen3 8B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-8B-Lora', 'together', 'Qwen/Qwen3-8B-Lora', 'Qwen3 8B Lora', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-30B-A3B-Instruct', 'together', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen3 Coder 30B A3b Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'together', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'Qwen3 Coder 480B A35B Instruct Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-Next-FP8', 'together', 'Qwen/Qwen3-Coder-Next-FP8', 'Qwen3 Coder Next Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Instruct', 'together', 'Qwen/Qwen3-Next-80B-A3B-Instruct', 'Qwen3 Next 80B A3b Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Instruct-FP8', 'together', 'Qwen/Qwen3-Next-80B-A3B-Instruct-FP8', 'Qwen3 Next 80B A3b Instruct Fp8', '', 'qwen3', 0, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Thinking', 'together', 'Qwen/Qwen3-Next-80B-A3B-Thinking', 'Qwen3 Next 80B A3b Thinking', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-235B-A22B-Instruct-FP8', 'together', 'Qwen/Qwen3-VL-235B-A22B-Instruct-FP8', 'Qwen3-VL-235B-A22B-Instruct-FP8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-32B-Instruct', 'together', 'Qwen/Qwen3-VL-32B-Instruct', 'Qwen3-VL-32B-Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-8B-Instruct', 'together', 'Qwen/Qwen3-VL-8B-Instruct', 'Qwen3-VL-8B-Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-122B-A10B-FP8', 'together', 'Qwen/Qwen3.5-122B-A10B-FP8', 'Qwen3.5 122B A10b Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-2B-Lora', 'together', 'Qwen/Qwen3.5-2B-Lora', 'Qwen3.5 2B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-35B-A3B', 'together', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.5 35B A3b', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-35B-A3B-Lora', 'together', 'Qwen/Qwen3.5-35B-A3B-Lora', 'Qwen3.5 35B A3B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-397B-A17B', 'together', 'Qwen/Qwen3.5-397B-A17B', 'Qwen3.5 397B A17b', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-9B', 'together', 'Qwen/Qwen3.5-9B', 'Qwen3.5 9B FP8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-9B-FP8', 'together', 'Qwen/Qwen3.5-9B-FP8', 'Qwen3.5 9B Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-35B-A3B-FP8', 'together', 'Qwen/Qwen3.6-35B-A3B-FP8', 'Qwen3.6 35B A3b Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-35B-A3B-Lora', 'together', 'Qwen/Qwen3.6-35B-A3B-Lora', 'Qwen3.6 35B A3B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-Plus', 'together', 'Qwen/Qwen3.6-Plus', 'Qwen3.6 Plus', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.7-Max', 'together', 'Qwen/Qwen3.7-Max', 'Qwen3.7 Max', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.7-Plus', 'together', 'Qwen/Qwen3.7-Plus', 'Qwen3.7 Plus', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.8-Flash', 'together', 'Qwen/Qwen3.8-Flash', 'Qwen3.8 Flash', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:agentica-org/DeepCoder-14B-Preview', 'together', 'agentica-org/DeepCoder-14B-Preview', 'Deepcoder 14B Preview', '', 'togethercomputer', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:allenai/Molmo-7B-D-0924', 'together', 'allenai/Molmo-7B-D-0924', 'Molmo 7B D 0924', '', 'allenai', 4096, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:arcee-ai/trinity-mini', 'together', 'arcee-ai/trinity-mini', 'Trinity Mini', '', 'arcee ai', 128000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:arize-ai/qwen-2-1.5b-instruct', 'together', 'arize-ai/qwen-2-1.5b-instruct', 'Arize AI Qwen 2 1.5B Instruct', '', 'togethercomputer', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-70B', 'together', 'deepcogito/cogito-v1-preview-llama-70B', 'Cogito V1 Preview Llama 70B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-70B-Turbo', 'together', 'deepcogito/cogito-v1-preview-llama-70B-Turbo', 'Cogito V1 Preview Llama 70B Turbo', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-8B', 'together', 'deepcogito/cogito-v1-preview-llama-8B', 'Cogito V1 Preview Llama 8B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-qwen-14B', 'together', 'deepcogito/cogito-v1-preview-qwen-14B', 'Cogito V1 Preview Qwen 14B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-qwen-32B', 'together', 'deepcogito/cogito-v1-preview-qwen-32B', 'Cogito V1 Preview Qwen 32B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v2-1-671b', 'together', 'deepcogito/cogito-v2-1-671b', 'Cogito v2.1 671B', '', 'deepcogito', 163840, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-OCR-2', 'together', 'deepseek-ai/DeepSeek-OCR-2', 'Deepseek OCR 2', '', 'deepseek', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-0528', 'together', 'deepseek-ai/DeepSeek-R1-0528', 'DeepSeek R1 0528 NVFP4', '', 'deepseek-r1', 163840, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'DeepSeek R1 Distill Llama 70B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', 'DeepSeek R1 Distill Qwen 1.5B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', 'DeepSeek R1 Distill Qwen 14B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'DeepSeek R1 Distill Qwen 7B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V3.1', 'together', 'deepseek-ai/DeepSeek-V3.1', 'Deepseek V3.1 NVFP4', '', 'deepseek-v3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V4-Pro', 'together', 'deepseek-ai/DeepSeek-V4-Pro', 'Deepseek V4 Pro', '', 'deepseek', 512000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V4.1-Flash-1017', 'together', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'DeepSeek V4.1 Flash 1017', '', 'deepseek', 1000000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/deepseek-coder-33b-instruct', 'together', 'deepseek-ai/deepseek-coder-33b-instruct', 'Deepseek Coder 33B Instruct', '', 'deepseek', 16384, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2-27b-it', 'together', 'google/gemma-2-27b-it', 'Gemma-2 Instruct (27B)', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2-9b-it', 'together', 'google/gemma-2-9b-it', 'Gemma 2 9B It', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2b-it', 'together', 'google/gemma-2b-it', 'Gemma 2B It', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-1b-it', 'together', 'google/gemma-3-1b-it', 'Gemma 3 1b it', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-270m-it', 'together', 'google/gemma-3-270m-it', 'Gemma 3 270M It', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-270m-it-lora', 'together', 'google/gemma-3-270m-it-lora', 'Gemma 3 270M It Lora', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-27b-it', 'together', 'google/gemma-3-27b-it', 'Gemma 3 27B It', '', 'gemma-3', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-4b-it', 'together', 'google/gemma-3-4b-it', 'Gemma 3 4b it', '', 'gemma-3', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3n-E4B-it', 'together', 'google/gemma-3n-E4B-it', 'Gemma 3N E4B Instruct', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-12B-it', 'together', 'google/gemma-4-12B-it', 'Gemma 4 12B It', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-26B-A4B-it', 'together', 'google/gemma-4-26B-A4B-it', 'Gemma 4 26B A4b It', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-31B-it', 'together', 'google/gemma-4-31B-it', 'Gemma 4 31B-it FP8', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-31B-it-lora', 'together', 'google/gemma-4-31B-it-lora', 'Gemma 4 31B It Lora', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-E2B-it', 'together', 'google/gemma-4-E2B-it', 'Gemma 4 E2B-it', '', 'gemma', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-E4B-it', 'together', 'google/gemma-4-E4B-it', 'Gemma 4 E4B-it', '', 'gemma', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/medgemma-27b-text-it', 'together', 'google/medgemma-27b-text-it', 'Medgemma 27B Text It', '', 'gemma-2', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-2-7b-chat-hf', 'together', 'meta-llama/Llama-2-7b-chat-hf', 'meta-llama/Llama-2-7b-chat-hf', '', 'llama-2', 4096, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3-8b-chat-hf', 'together', 'meta-llama/Llama-3-8b-chat-hf', 'Meta Llama 3 8B Instruct Reference', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.1-405B', 'together', 'meta-llama/Llama-3.1-405B', 'Llama 3.1 405B', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.1-405B-Instruct', 'together', 'meta-llama/Llama-3.1-405B-Instruct', 'Meta Llama 3.1 405B Instruct', '', 'llama-3.1', 4096, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-1B', 'together', 'meta-llama/Llama-3.2-1B', 'Llama 3.2 1B', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-1B-Instruct', 'together', 'meta-llama/Llama-3.2-1B-Instruct', 'Meta Llama 3.2 1B Instruct', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-3B-Instruct', 'together', 'meta-llama/Llama-3.2-3B-Instruct', 'Meta Llama 3.2 3B Instruct', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct', 'together', 'meta-llama/Llama-3.3-70B-Instruct', 'Meta Llama 3.3 70B Instruct', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct-FP8-Lora', 'together', 'meta-llama/Llama-3.3-70B-Instruct-FP8-Lora', 'Llama 3.3 70B Instruct FP8 Lora', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Meta Llama 3.3 70B Instruct Turbo', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP4', 'together', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP4', 'Llama 4 Maverick 17B 128E Instruct Nvfp4', '', 'llama-4', 1048576, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E', 'together', 'meta-llama/Llama-4-Scout-17B-16E', 'Llama 4 Scout (17Bx16E)', '', 'llama-4', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E-Instruct', 'together', 'meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout Instruct (17Bx16E)', '', 'llama-4', 1048576, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E-Instruct-FP8-Lora', 'together', 'meta-llama/Llama-4-Scout-17B-16E-Instruct-FP8-Lora', 'Llama 4 Scout 17B 16E Instruct Fp8 Lora', '', 'llama-4', 10485760, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-70B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3-70B-Instruct-Turbo', 'Meta Llama 3 70B Instruct Turbo', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-8B-Instruct', 'together', 'meta-llama/Meta-Llama-3-8B-Instruct', 'Meta Llama 3 8B Instruct', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-8B-Instruct-Lite', 'together', 'meta-llama/Meta-Llama-3-8B-Instruct-Lite', 'Meta Llama 3 8B Instruct Lite', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-70B', 'together', 'meta-llama/Meta-Llama-3.1-70B', 'Llama 3.1 70B', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Meta Llama 3.1 70B Instruct Turbo', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Meta Llama 3.1 8B Instruct Turbo', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Devstral-Small-2505', 'together', 'mistralai/Devstral-Small-2505', 'Devstral Small 2505', '', 'mistral', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Magistral-Small-2506', 'together', 'mistralai/Magistral-Small-2506', 'Magistral Small 2506', '', 'mistral', 40960, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Ministral-3-14B-Instruct-2512', 'together', 'mistralai/Ministral-3-14B-Instruct-2512', 'Ministral 3 14B Instruct 2512', '', 'mistral', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-Instruct-v0.1', 'together', 'mistralai/Mistral-7B-Instruct-v0.1', 'Mistral (7B) Instruct v0.1', '', 'mistral', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-Instruct-v0.3', 'together', 'mistralai/Mistral-7B-Instruct-v0.3', 'Mistral (7B) Instruct v0.3', '', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-v0.1', 'together', 'mistralai/Mistral-7B-v0.1', 'Mistral 7B v0.1', '', 'mistral', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-Small-24B-Instruct-2501', 'together', 'mistralai/Mistral-Small-24B-Instruct-2501', 'Mistral Small (24B) Instruct 25.01', '', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x22B-Instruct-v0.1', 'together', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'Mixtral 8X22b Instruct V0.1', '', 'mixtral', 65536, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x7B-Instruct-v0.1', 'together', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Mixtral-8x7B Instruct v0.1', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x7B-Instruct-v0.1-FP8-Lora', 'together', 'mistralai/Mixtral-8x7B-Instruct-v0.1-FP8-Lora', 'Mixtral 8x7B Instruct V0.1 FP8 Lora', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.5-fp4', 'together', 'moonshotai/Kimi-K2.5-fp4', 'Kimi K2.5 Fp4', '', 'togethercomputer', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.6', 'together', 'moonshotai/Kimi-K2.6', 'Kimi K2.6 Fp4', '', 'moonshot ai', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.7-Code', 'together', 'moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', '', 'moonshot ai', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K3.1-Pro', 'together', 'moonshotai/Kimi-K3.1-Pro', 'Kimi K3.1 Pro', '', 'moonshot ai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.1-70b-instruct', 'together', 'nim/meta/llama-3.1-70b-instruct', 'nim/meta/llama-3.1-70b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.1-8b-instruct', 'together', 'nim/meta/llama-3.1-8b-instruct', 'nim/meta/llama-3.1-8b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.2-11b-vision-instruct', 'together', 'nim/meta/llama-3.2-11b-vision-instruct', 'nim/meta/llama-3.2-11b-vision-instruct', '', 'llama-3.2', 16384, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.2-90b-vision-instruct', 'together', 'nim/meta/llama-3.2-90b-vision-instruct', 'nim/meta/llama-3.2-90b-vision-instruct', '', 'llama-3.2', 16384, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.3-70b-instruct', 'together', 'nim/meta/llama-3.3-70b-instruct', 'nim/meta/llama-3.3-70b-instruct', '', 'llama-3.3', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/mistralai/mixtral-8x22b-instruct-v01', 'together', 'nim/mistralai/mixtral-8x22b-instruct-v01', 'nim/mistralai/mixtral-8x22b-instruct-v01', '', 'mixtral', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/mistralai/mixtral-8x7b-instruct-v01', 'together', 'nim/mistralai/mixtral-8x7b-instruct-v01', 'nim/mistralai/mixtral-8x7b-instruct-v01', '', 'mixtral', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nv-mistralai/mistral-nemo-12b-instruct', 'together', 'nim/nv-mistralai/mistral-nemo-12b-instruct', 'nim/nv-mistralai/mistral-nemo-12b-instruct', '', 'mistral', 16384, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nvidia/llama-3.1-nemotron-70b-instruct', 'together', 'nim/nvidia/llama-3.1-nemotron-70b-instruct', 'nim/nvidia/llama-3.1-nemotron-70b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nvidia/llama-3.3-nemotron-super-49b-v1', 'together', 'nim/nvidia/llama-3.3-nemotron-super-49b-v1', 'nim/nvidia/llama-3.3-nemotron-super-49b-v1', '', 'llama-3.3', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', 'together', 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', 'Llama 3.1 Nemotron 70B Instruct HF', '', 'llama-3.1', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'together', 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'Nvidia Nemotron 3 Nano 30B A3b Bf16', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16', 'together', 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16', 'Nvidia Nemotron 3 Super 120B A12b Bf16', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8', 'together', 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8', 'Nvidia Nemotron 3 Super 120B A12b Fp8', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'together', 'nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'Nvidia Nemotron 3.5 Super VL', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'together', 'nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'Nvidia Nemotron Nano 9B V2', '', 'nvidia', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-fp8', 'together', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-fp8', 'Nemotron 3 Nano Omni 30B A3b Reasoning Fp8', '', 'nvidia', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/nemotron-3-ultra-550b-a55b', 'together', 'nvidia/nemotron-3-ultra-550b-a55b', 'NVIDIA Nemotron 3 Ultra 550B A55B NVFP4', '', 'nvidia', 512288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:openai/gpt-oss-120b', 'together', 'openai/gpt-oss-120b', 'OpenAI GPT-OSS 120B', '', 'gpt-oss', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:openai/gpt-oss-20b', 'together', 'openai/gpt-oss-20b', 'OpenAI GPT-OSS 20B', '', 'gpt-oss', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:pearl-ai/gemma-4-31b-it', 'together', 'pearl-ai/gemma-4-31b-it', 'Pearl-ai Gemma-4-31B-it-pearl', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:sarvamai/sarvam-m', 'together', 'sarvamai/sarvam-m', 'Sarvam M', '', 'sarvamai', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:thinkingmachines/Inkling', 'together', 'thinkingmachines/Inkling', 'Inkling FP4', '', 'thinking machines', 524288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:togethercomputer/EssentialAI-RNJ-1-Instruct', 'together', 'togethercomputer/EssentialAI-RNJ-1-Instruct', 'EssentialAI Rnj-1 Instruct', '', 'essential ai', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:togethercomputer/meta-llama-3.1-8B-Instruct-AWQ-INT4', 'together', 'togethercomputer/meta-llama-3.1-8B-Instruct-AWQ-INT4', 'Meta Llama 3.1 8B Instruct Awq Int4', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.5-Air-FP8', 'together', 'zai-org/GLM-4.5-Air-FP8', 'Glm 4.5 Air Fp8', '', 'zai org', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.5V', 'together', 'zai-org/GLM-4.5V', 'GLM 4.5V', '', 'zai org', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.6', 'together', 'zai-org/GLM-4.6', 'GLM 4.6 Fp8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7', 'together', 'zai-org/GLM-4.7', 'GLM 4.7 FP8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7-FP8', 'together', 'zai-org/GLM-4.7-FP8', 'Glm 4.7 Fp8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7-fp4', 'together', 'zai-org/GLM-4.7-fp4', 'GLM 4.7 FP4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5', 'together', 'zai-org/GLM-5', 'GLM 5 Fp4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5-FP4', 'together', 'zai-org/GLM-5-FP4', 'GLM 5 Fp4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.1', 'together', 'zai-org/GLM-5.1', 'GLM 5.1 FP4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.2', 'together', 'zai-org/GLM-5.2', 'GLM 5.2', '', 'zai org', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.3', 'together', 'zai-org/GLM-5.3', 'GLM 5.3', '', 'zai org', 1048575, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.3-Flash', 'together', 'zai-org/GLM-5.3-Flash', 'GLM 5.3 Flash', '', 'zai org', 1048575, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-OCR', 'together', 'zai-org/GLM-OCR', 'GLM OCR', '', 'zai org', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- xAI — Grok. (8 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('xai:grok-4.20-0309-non-reasoning', 'xai', 'grok-4.20-0309-non-reasoning', 'Grok 4.20 0309 Non Reasoning', '', 'grok-4', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.20-0309-reasoning', 'xai', 'grok-4.20-0309-reasoning', 'Grok 4.20 0309 Reasoning', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.20-multi-agent-0309', 'xai', 'grok-4.20-multi-agent-0309', 'Grok 4.20 Multi Agent 0309', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.3', 'xai', 'grok-4.3', 'Grok 4.3', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.5', 'xai', 'grok-4.5', 'Grok 4.5', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.6', 'xai', 'grok-4.6', 'Grok 4.6', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.7', 'xai', 'grok-4.7', 'Grok 4.7', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-build-0.1', 'xai', 'grok-build-0.1', 'Grok Build 0.1', '', 'grok', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- DeepSeek. (2 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('deepseek:deepseek-flash', 'deepseek', 'deepseek-flash', 'DeepSeek Flash', '', 'deepseek-chat', 1000000, 393216, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('deepseek:deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', '', 'deepseek-chat', 1000000, 393216, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;
