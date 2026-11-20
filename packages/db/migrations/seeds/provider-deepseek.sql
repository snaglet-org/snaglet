-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- DeepSeek provider card + its API-key auth type.

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('deepseek', 'DeepSeek', 'DeepSeek-V3 (chat) and DeepSeek-R1 (reasoner) via an OpenAI-compatible API.', 'https://deepseek.com', 'https://api-docs.deepseek.com', 23, '{"defaultModelId": "deepseek-v4-pro", "summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;

-- provider_auth_types
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('deepseek:api-key', 'deepseek', 'API Key', 'api_key', 'Use a DeepSeek API key.', 'API Key', 'sk-…', 'Get your key at platform.deepseek.com → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
