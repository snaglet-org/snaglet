/**
 * model(op: add) — add (or update) a custom chat model on an LLM provider.
 *
 * Agent-facing twin of POST /api/models: same Models.createModel upsert, plus
 * the input validation the route leaves to the UI form. Provider must exist
 * and be an 'llm' provider — runtime (built-in local) and integration
 * providers are managed by Snaglet, not by agents. Embedding models cannot be
 * added: Snaglet embeds with its one built-in local model.
 */
import { Models } from '@snaglet/db/tables/models';
import { Providers } from '@snaglet/db/tables/providers';
import type { ModelMetadata } from '@snaglet/shared/types';
import type { ToolHandler } from '@server/services/ToolService/types';
import { emitModelsChanged } from '@server/realtime/surfaces/models';

const fail = (output: string) => ({ output, rawContent: { error: output } });

/** Answer for the embedding inputs (`model_type: "embedding"`, `dimensions`) the tool no longer takes. */
const EMBEDDING_MODELS_NOT_SUPPORTED =
  'Embedding models cannot be added: Snaglet embeds with its built-in local model, which needs no ' +
  'setup. op add takes chat models only, so `model_type: "embedding"` and `dimensions` are not ' +
  'supported. Nothing was changed.';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** undefined when absent; an error string when present but invalid. */
function posInt(v: unknown, name: string): number | undefined | string {
  if (v == null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return `\`${name}\` must be a positive integer.`;
  }
  return v;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const META_KEYS = new Set(['safetyMarginPct', 'cacheTtl', 'contextCompression', 'summary']);

/** Validate the agent-supplied metadata; returns the clean object or an error string. */
export function parseModelMetadata(raw: unknown): ModelMetadata | string {
  if (raw == null) return {};
  if (!isObj(raw)) return '`metadata` must be an object.';
  const unknownKeys = Object.keys(raw).filter((k) => !META_KEYS.has(k));
  if (unknownKeys.length) {
    return `Unsupported metadata key(s): ${unknownKeys.join(', ')}. Allowed: ${[...META_KEYS].join(', ')}.`;
  }
  const out: ModelMetadata = {};
  if (raw.safetyMarginPct != null) {
    const p = raw.safetyMarginPct;
    if (typeof p !== 'number' || p < 0 || p > 90) return '`metadata.safetyMarginPct` must be 0–90.';
    out.safetyMarginPct = p;
  }
  if (raw.cacheTtl != null) {
    if (raw.cacheTtl !== '5m' && raw.cacheTtl !== '1h')
      return '`metadata.cacheTtl` must be "5m" or "1h".';
    out.cacheTtl = raw.cacheTtl;
  }
  if (raw.contextCompression != null) {
    const c = raw.contextCompression;
    if (!isObj(c)) return '`metadata.contextCompression` must be an object.';
    const extra = Object.keys(c).filter((k) => k !== 'tokenBudgetRatio' && k !== 'tailMessages');
    if (extra.length) return `Unsupported contextCompression key(s): ${extra.join(', ')}.`;
    const cc: NonNullable<ModelMetadata['contextCompression']> = {};
    if (c.tokenBudgetRatio != null) {
      const r = c.tokenBudgetRatio;
      if (typeof r !== 'number' || r <= 0 || r > 1) {
        return '`metadata.contextCompression.tokenBudgetRatio` must be > 0 and ≤ 1.';
      }
      cc.tokenBudgetRatio = r;
    }
    if (c.tailMessages != null) {
      const t = c.tailMessages;
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) {
        return '`metadata.contextCompression.tailMessages` must be a non-negative integer.';
      }
      cc.tailMessages = t;
    }
    out.contextCompression = cc;
  }
  if (raw.summary != null) {
    const s = raw.summary;
    if (!isObj(s)) return '`metadata.summary` must be an object.';
    const extra = Object.keys(s).filter((k) => k !== 'maxWords' && k !== 'tokenThreshold');
    if (extra.length) return `Unsupported summary key(s): ${extra.join(', ')}.`;
    const sm: NonNullable<ModelMetadata['summary']> = {};
    for (const k of ['maxWords', 'tokenThreshold'] as const) {
      if (s[k] == null) continue;
      const v = s[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        return `\`metadata.summary.${k}\` must be a positive integer.`;
      }
      sm[k] = v;
    }
    out.summary = sm;
  }
  return out;
}

const handler: ToolHandler = async (input) => {
  const providerId = str(input.provider_id);
  const modelId = str(input.model_id);
  if (!providerId || !modelId) return fail('`provider_id` and `model_id` are required.');

  // A caller may still send `model_type: "llm"`; that is harmless.
  if ((input.model_type != null && input.model_type !== 'llm') || input.dimensions != null) {
    return fail(EMBEDDING_MODELS_NOT_SUPPORTED);
  }
  // `model_kind` picks a catalog for op list; on op add it would otherwise be
  // ignored and an embedding model id would become an unusable chat row.
  if (input.model_kind != null) {
    return fail(
      '`model_kind` belongs to op list (it picks the catalog to list), not op add. op add ' +
        'takes chat models only: Snaglet embeds with its built-in local model. Nothing was changed.'
    );
  }
  const ctx = posInt(input.context_window_tokens, 'context_window_tokens');
  const maxOut = posInt(input.max_output_tokens, 'max_output_tokens');
  for (const v of [ctx, maxOut]) if (typeof v === 'string') return fail(v);
  const metadata = parseModelMetadata(input.metadata);
  if (typeof metadata === 'string') return fail(metadata);

  const provider = await Providers.findProvider(providerId);
  if (!provider) {
    return fail(`Provider "${providerId}" not found. Use model op:"list" to see providers.`);
  }
  if (provider.type !== 'llm') {
    return fail(
      `Provider "${providerId}" is a ${provider.type} provider; custom models can only be added to LLM providers.`
    );
  }

  const existing = await Models.findByProviderAndModelId(providerId, modelId);
  const row = await Models.createModel(
    providerId,
    modelId,
    str(input.display_name),
    metadata,
    ctx as number | undefined,
    maxOut as number | undefined
  );
  emitModelsChanged(providerId);

  const verb = !existing ? 'Added' : existing.isActive ? 'Updated' : 'Restored';
  const details = [
    `type ${row.type}`,
    row.contextWindowTokens ? `context ${row.contextWindowTokens}` : null,
    row.maxOutputTokens ? `max output ${row.maxOutputTokens}` : null,
  ].filter(Boolean);
  return {
    output: `${verb} model "${row.displayName}" (${row.modelId}) on ${providerId} — ${details.join(', ')}. Row id: ${row.id}.`,
    rawContent: {
      action: verb.toLowerCase(),
      model: {
        id: row.id,
        providerId: row.providerId,
        modelId: row.modelId,
        displayName: row.displayName,
        type: row.type,
        contextWindowTokens: row.contextWindowTokens,
        maxOutputTokens: row.maxOutputTokens,
        isActive: row.isActive,
        metadata: row.metadata,
      },
    },
  };
};

export default handler;
