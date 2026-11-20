import type { DiscoveredCatalog, DiscoveredModel } from '../types';
import {
  getOllamaApiRoot,
  inferOllamaContextWindow,
  inferOllamaDisplayName,
  inferOllamaFamily,
  inferOllamaVision,
  resolveOllamaBaseUrl,
} from '@server/services/ProviderChatService/providers/ollama';
import { isEmbeddingModelName, isRerankerModelName } from '../modelNameKind';

interface OllamaModelDetails {
  family?: string;
  families?: string[];
  format?: string;
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaModelEntry {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: OllamaModelDetails;
}

interface OllamaTagsResponse {
  models?: OllamaModelEntry[];
}

/** Subset of Ollama POST /api/show response we consume. */
interface OllamaShowResponse {
  details?: OllamaModelDetails;
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

interface OllamaShowMetadata {
  contextWindow: number | null;
  capabilities: string[];
}

const OLLAMA_MAX_OUTPUT_TOKENS = 8_192;

export class OllamaNotInstalledError extends Error {
  constructor() {
    super('Ollama is not installed or not running on this machine');
    this.name = 'OllamaNotInstalledError';
  }
}

/**
 * The installed chat models, plus the id of every installed model (embedders
 * and rerankers included) for the dispatcher's stale audit.
 */
export async function discoverOllamaCatalog(): Promise<DiscoveredCatalog> {
  const baseUrl = await resolveOllamaBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${getOllamaApiRoot(baseUrl)}/api/tags`, {
      headers: { Accept: 'application/json' },
    });
  } catch (err: unknown) {
    // Connection refused / not reachable — Ollama is not installed or not running
    throw new OllamaNotInstalledError();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 404 or similar on a running server — still not usable
    if (res.status === 404) throw new OllamaNotInstalledError();
    throw new Error(`Ollama /api/tags failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as OllamaTagsResponse;
  const entries = Array.isArray(json.models) ? json.models : [];

  // Local discovery: fan out /api/show per installed model to get real
  // metadata (context window, capabilities) instead of name-based inference.
  // This is what differentiates local Ollama discovery from remote catalog
  // discovery.
  const enriched = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      show: await fetchOllamaShow(baseUrl, entry.name),
    }))
  );

  return {
    models: enriched
      .filter(({ entry, show }) => isChatModel(entry, show))
      .map(({ entry, show }) => normalize(entry, show)),
    installedModelIds: entries.map((entry) => entry.name),
  };
}

async function fetchOllamaShow(baseUrl: string, name: string): Promise<OllamaShowMetadata | null> {
  try {
    const res = await fetch(`${getOllamaApiRoot(baseUrl)}/api/show`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as OllamaShowResponse;
    const modelInfo = json.model_info ?? {};

    // model_info keys are architecture-prefixed, e.g. "llama.context_length" —
    // match by suffix.
    const numberBySuffix = (suffix: string): number | null => {
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith(suffix) && typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
      }
      return null;
    };

    return {
      contextWindow: numberBySuffix('.context_length'),
      capabilities: Array.isArray(json.capabilities) ? json.capabilities : [],
    };
  } catch {
    // /api/show is best-effort enrichment — fall back to name inference.
    return null;
  }
}

/** Chat models only: embedding and reranker models are left out. */
function isChatModel(entry: OllamaModelEntry, show: OllamaShowMetadata | null): boolean {
  if (isRerankerModelName(entry.name)) return false;
  // Prefer authoritative capabilities from /api/show over name heuristics.
  if (show && show.capabilities.length > 0) {
    return show.capabilities.includes('completion') && !show.capabilities.includes('embedding');
  }
  return !isEmbeddingModelName(entry.name);
}

function normalize(entry: OllamaModelEntry, show: OllamaShowMetadata | null): DiscoveredModel {
  const modelId = entry.name;
  const families = entry.details?.families ?? [];
  const supportsVision =
    inferOllamaVision(modelId) ||
    families.some((family) => /vision|llava|mllama/i.test(family)) ||
    (show?.capabilities.includes('vision') ?? false);

  return {
    modelId,
    displayName: inferOllamaDisplayName(modelId),
    family: entry.details?.family ?? inferOllamaFamily(modelId),
    // Real context window from /api/show when available; fall back to name inference.
    contextWindowTokens: show?.contextWindow ?? inferOllamaContextWindow(modelId),
    maxOutputTokens: OLLAMA_MAX_OUTPUT_TOKENS,
    supportsTools: !show || show.capabilities.length === 0 || show.capabilities.includes('tools'),
    supportsVision,
    supportsReasoning: false,
    isPreview: false,
    alreadyImported: false,
  };
}
