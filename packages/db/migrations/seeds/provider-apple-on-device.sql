-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- Apple on-device foundation-model provider card, auth type, and fixed model
-- row (keyless local runtime, like ollama).

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('apple-on-device', 'Apple On-Device', 'Apple''s on-device FoundationModels LLM (~3B params). Runs fully locally via a Swift sidecar — no network, no API key. Requires macOS 26+ with Apple Intelligence enabled. 4096-token context window.', 'https://developer.apple.com/documentation/foundationmodels', 'https://developer.apple.com/documentation/foundationmodels', 8, '{"summary": {"maxWords": 300, "messageThreshold": 8}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 6, "maxSummaryChars": 1200, "compressAfterMessages": 4}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;

-- provider_auth_types
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('apple-on-device:none', 'apple-on-device', 'No Auth', 'none', 'Runs Apple''s on-device model locally. No API key is required. Requires macOS 26+ with Apple Intelligence enabled.', NULL, NULL, 'Enable Apple Intelligence in System Settings → Apple Intelligence & Siri. No further setup needed — Snaglet builds and runs the sidecar automatically.', 0, NULL) ON CONFLICT (id) DO NOTHING;

-- models: the single fixed on-device model. Fixed id so a replay (see
-- SEED_REPLAY_FILES) targets the same row.
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-7ac7667f-c14c-43e4-be58-ea2539966218',
  'apple-on-device',
  'apple-on-device',
  'Apple On-Device (~3B)',
  'Apple''s on-device FoundationModels LLM. Streams via a local Swift sidecar; 4096-token total context window (prompt + completion).',
  'apple-foundation',
  4096,
  1024,
  false,
  false,
  false,
  'llm',
  NULL,
  0,
  '{}'::jsonb
) ON CONFLICT (provider_id, model_id) DO NOTHING;
