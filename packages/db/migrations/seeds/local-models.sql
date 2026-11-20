-- Builtin-catalog seed. Replayed by `ensureBuiltinCatalog` on every boot and
-- by the clean-slate reset (`DatabaseBackupService.doReset`); the same rows are
-- baked into `0001_init.sql` for fresh installs. Every statement must stay
-- idempotent (ON CONFLICT ... DO NOTHING / DO UPDATE) and free of
-- BEGIN/COMMIT — see the SEED_REPLAY_FILES doc in ../../migrations.ts.
--
-- The local-onnx embedder provider + nomic embedder model row, the MiniLM-L6
-- reranker model row, and the remote embedding backends marked inactive.
-- Statement order matters: runs after provider-snaglet-local.sql.

-- The local-onnx provider + the 768-dimension nomic embedder model.
INSERT INTO public.providers (
  id, name, description, website, api_docs, sort_order,
  default_metadata, base_url, type
) VALUES (
  'local-onnx',
  'Snaglet Local Embedder',
  'Built-in local embedding runtime (onnxruntime-node). Ships with nomic-embed-text-v1.5; no API key, no network.',
  NULL,
  NULL,
  12,
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

INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-8f21c9d4-6a35-5e0b-9c47-2de1a07b4f63',
  'local-onnx',
  'nomic-embed-text-v1.5',
  'Nomic Embed Text v1.5 (int8 ONNX)',
  'Local 768-dimension bi-encoder embedding model. Task prefixes (search_document:/search_query:) are applied by the embedder service.',
  'embedding',
  512,
  1,
  false,
  false,
  false,
  'embedding',
  768,
  10,
  '{
    "embedding": {
      "runtime": "onnxruntime-node",
      "architecture": "nomic-bert",
      "sourceModel": "nomic-ai/nomic-embed-text-v1.5",
      "modelFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/onnx/model_quantized.onnx",
      "vocabFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/vocab.txt",
      "tokenizerConfigFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/tokenizer_config.json",
      "sha256": "b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27",
      "maxSequenceTokens": 512,
      "defaultBatchSize": 8
    }
  }'::jsonb
) ON CONFLICT (provider_id, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  family = EXCLUDED.family,
  context_window_tokens = EXCLUDED.context_window_tokens,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_tools = EXCLUDED.supports_tools,
  supports_vision = EXCLUDED.supports_vision,
  supports_reasoning = EXCLUDED.supports_reasoning,
  type = EXCLUDED.type,
  dimensions = EXCLUDED.dimensions,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  is_active = TRUE,
  updated_at = NOW();

-- Remote embedding backends stay in the catalog, inactive.
UPDATE public.models
SET is_active = FALSE, updated_at = NOW()
WHERE type = 'embedding'
  AND provider_id <> 'local-onnx';

-- The MiniLM-L6 reranker model.
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-7b3f2a91-5c48-5f1e-8d26-4a9e0c317b52',
  'snaglet-local',
  'ms-marco-MiniLM-L6-v2-qint8-arm64',
  'MiniLM L6 Reranker (qint8 ARM64)',
  'Local ONNX cross-encoder reranker for scoring workspace context candidates before they are injected into an agent turn.',
  'reranking',
  512,
  1,
  false,
  false,
  false,
  'reranker',
  NULL,
  10,
  '{
    "reranking": {
      "runtime": "onnxruntime-node",
      "architecture": "bert-cross-encoder",
      "sourceModel": "cross-encoder/ms-marco-MiniLM-L6-v2",
      "modelFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/onnx/model_qint8_arm64.onnx",
      "vocabFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/vocab.txt",
      "tokenizerConfigFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/tokenizer_config.json",
      "sha256": "3573b6b9593cb2f75987a31815d409ca3dd8808629118fd20451bb1a5d90cec7",
      "maxSequenceTokens": 512,
      "defaultBatchSize": 8
    }
  }'::jsonb
) ON CONFLICT (provider_id, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  family = EXCLUDED.family,
  context_window_tokens = EXCLUDED.context_window_tokens,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_tools = EXCLUDED.supports_tools,
  supports_vision = EXCLUDED.supports_vision,
  supports_reasoning = EXCLUDED.supports_reasoning,
  type = EXCLUDED.type,
  dimensions = EXCLUDED.dimensions,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  is_active = TRUE,
  updated_at = NOW();
