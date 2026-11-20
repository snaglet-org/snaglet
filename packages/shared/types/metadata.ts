/**
 * Model / provider metadata shapes for context-window compression
 * and summary generation defaults.
 *
 * Resolution chain (see apps/server/src/services/metadataResolver.ts):
 *   agent override → thread override → models.metadata
 *     → providers.default_metadata → hardcoded code defaults
 *
 * Field names here intentionally mirror `HistoryConfig` in ./config.ts so the
 * resolver can shallow-merge without translation. There are only two policy
 * knobs in the system: how many tail messages to keep verbatim, and what
 * fraction of the context window triggers compression. Everything else
 * (compression-trigger floor, summary char cap, DB read ceiling) lives as an
 * internal constant in ContextWindowService.
 */

export interface ContextCompressionMeta {
  /** Compression triggers when projected tokens exceed this fraction of the model's context window (0–1). */
  tokenBudgetRatio?: number;
  /** Number of most-recent messages always preserved verbatim (never summarized). */
  tailMessages?: number;
}

export interface SummaryMeta {
  /** Provider-level only: which model on this provider runs summarization. */
  defaultModelId?: string;
  /** Max words in a generated thread summary. */
  maxWords?: number;
  /**
   * Estimated tokens of new conversation that make the thread digest due (default 20,000). The
   * digest feeds search, embeddings and the thread list; it is never put in an agent's context.
   */
  tokenThreshold?: number;
}

export interface RerankingMeta {
  /** Runtime used to execute the local reranker model. */
  runtime?: 'onnxruntime-node' | string;
  /** Model architecture family; current local runtime expects a BERT cross-encoder. */
  architecture?: 'bert-cross-encoder' | string;
  /** Upstream model id used to create this local asset. */
  sourceModel?: string;
  /** Local path to the ONNX model file. `~` resolves to the user's home directory. */
  modelFile?: string;
  /** Local path to the BERT WordPiece vocabulary file. */
  vocabFile?: string;
  /** Optional local path to tokenizer_config.json. */
  tokenizerConfigFile?: string;
  /** Expected SHA-256 for the ONNX model file. */
  sha256?: string;
  /** Maximum pair sequence length accepted by the model. */
  maxSequenceTokens?: number;
  /** Default candidate batch size for inference. */
  defaultBatchSize?: number;
}

/**
 * Entitlement verdict cached on a model row for the current credential.
 *
 * Two verdict families share this shape:
 *
 *   - Probe-based (codex, together): the reconciliation pass probes each
 *     candidate with a minimal 1-token request. `ok` keeps the row active;
 *     `blocked` deactivates it, recording the upstream reason.
 *
 *   - Payload/chat-based (copilot): never probed (probing would burn premium
 *     quota). `available` is the normal state. `plan_blocked` means the
 *     account's Copilot plan/integrator doesn't currently allow the model —
 *     the row stays active and visible (badged "not on your plan" in pickers)
 *     and remains pinnable, because entitlement changes (plan upgrades, quota
 *     resets) and deactivating would bake today's plan in permanently. A run
 *     against a `plan_blocked` model fails that turn with a clear message.
 *     The status is set from the discovery payload (`policy.state`) and from
 *     chat-time rejections, and re-evaluated on every discovery refresh so a
 *     plan change clears it automatically.
 */
export interface ModelEntitlementMeta {
  status: 'ok' | 'available' | 'blocked' | 'plan_blocked';
  /** Upstream reason when blocked (e.g. "not supported when using Codex with a ChatGPT account"). */
  reason?: string;
  /** ISO timestamp of the verdict. */
  checkedAt?: string;
  /** Where the verdict came from — a live probe, a chat-time rejection, or the discovery payload. */
  source?: 'probe' | 'chat' | 'discovery';
}

export interface ModelMetadata {
  contextCompression?: ContextCompressionMeta;
  summary?: SummaryMeta;
  reranking?: RerankingMeta;
  /** Entitlement-probe verdict for the current credential (see ModelEntitlementMeta). */
  entitlement?: ModelEntitlementMeta;
  /**
   * Deactivation provenance. `'user'` means the row was deliberately removed
   * via the UI/API (DELETE /api/models/:id); reconciliation passes must never
   * reactivate it. Rows deactivated without this marker stay eligible for
   * reactivation. Cleared when the model
   * is explicitly re-added/re-imported (createModel/bulkUpsert upsert).
   */
  deactivatedBy?: 'user';
  /**
   * Limit provenance. `'user'` means a person set this row's context window or
   * max output (PATCH /api/models/:id, the agent `model` tool's add); a
   * discovery pass then never replaces them with provider-reported values.
   */
  limitsEditedBy?: 'user';
  /**
   * Where the provider has the model in its lifecycle when it is not current:
   * `'legacy'` (still served, superseded) or `'deprecated'` (a retirement date
   * is set). Such models list after current ones and are never the suggested
   * default. Absent means current.
   */
  lifecycle?: 'legacy' | 'deprecated';
  /**
   * Percentage shaved off the declared context window before budget math
   * — declared windows are often theoretical
   * (Gemini's 1M) or config-dependent (Ollama's load-time num_ctx). 0–90.
   * Resolution: model row → provider default_metadata → per-provider code
   * default in ContextWindowService.
   */
  safetyMarginPct?: number;
  /**
   * Anthropic prompt-cache TTL for this model's breakpoints. Default when
   * unset: '1h' for chat turns. Ignored by providers that auto-cache.
   */
  cacheTtl?: '5m' | '1h';
  /**
   * @deprecated Use models.dimensions. Kept only so old metadata rows can be
   * read and migrated.
   */
  dimensions?: number | null;
  /**
   * @deprecated Use first-class model columns (`type`, supports_*,
   * dimensions). Kept only so old metadata rows can be read and migrated.
   */
  capabilities?: string[];
}

export interface ProviderDefaultMetadata {
  /**
   * The model an agent with none takes on this provider, when the display
   * order alone cannot know it (a provider that also hosts other vendors'
   * models). Used only while that model is listed, active and current.
   */
  defaultModelId?: string;
  contextCompression?: ContextCompressionMeta;
  summary?: SummaryMeta;
  /** See ModelMetadata.safetyMarginPct — provider-level default. */
  safetyMarginPct?: number;
  /** See ModelMetadata.cacheTtl — provider-level default. */
  cacheTtl?: '5m' | '1h';
}
