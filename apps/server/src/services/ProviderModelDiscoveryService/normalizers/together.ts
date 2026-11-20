import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { resolveTogetherBaseUrl } from '@server/services/ProviderChatService/providers/together';
import type { DiscoveredModel } from '../types';

/**
 * Together's GET /v1/models returns a flat array (not wrapped in `{data}`)
 * of every hosted model — chat, embedding, image, rerank, moderation, audio,
 * language. Each entry has `type`, `display_name`, `organization`, and
 * `context_length`, so we can map directly without inferring a context window.
 *
 * Tool / vision / reasoning support isn't a flag on the response; we infer it
 * from the model id, since Together's catalog is open-weight families whose
 * capabilities are well-known (Llama 3.1+ tools, Llama 3.2 Vision, DeepSeek-R1
 * reasoning, etc.).
 */

interface TogetherModelEntry {
  id: string;
  object?: string;
  type?: string;
  running?: boolean;
  display_name?: string;
  organization?: string;
  link?: string;
  license?: string;
  context_length?: number;
  config?: {
    chat_template?: string;
    stop?: string[];
    bos_token?: string;
    eos_token?: string;
  };
  pricing?: {
    hourly?: number;
    input?: number;
    output?: number;
    base?: number;
    finetune?: number;
  };
}

interface TogetherModelsResponseObject {
  data?: TogetherModelEntry[];
  object?: string;
}

type TogetherModelsResponse = TogetherModelEntry[] | TogetherModelsResponseObject;

/**
 * A user's dedicated endpoint, from GET /v1/endpoints?type=dedicated&mine=true.
 * `name` (not `id`) is the string that must be sent as `model` on chat
 * completions — `id` (`endpoint-<uuid>`) is only valid for endpoint
 * management calls (start/stop/delete). `model` is the underlying base model
 * id, useful for display/family inference but not callable once a model is
 * dedicated-only (see the together.ts probe comment for why).
 */
interface TogetherEndpointEntry {
  object?: 'endpoint';
  id: string;
  name: string;
  display_name?: string;
  model: string;
  hardware?: string;
  type?: 'dedicated' | 'serverless';
  owner?: string;
  state?: string;
  autoscaling?: { min_replicas?: number; max_replicas?: number };
  created_at?: string;
}

interface TogetherEndpointsResponse {
  data?: TogetherEndpointEntry[];
  object?: string;
}

export async function discoverTogetherModels(): Promise<DiscoveredModel[]> {
  const secret = await providerCredentialService.getSecret('together');
  if (!secret) {
    throw new Error('No Together AI credential configured');
  }

  const baseUrl = await resolveTogetherBaseUrl();
  const authHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${secret}`,
  };

  const [catalogModels, dedicatedEndpoints] = await Promise.all([
    fetchServerlessCatalog(baseUrl, authHeaders),
    fetchDedicatedEndpoints(baseUrl, authHeaders),
  ]);

  return [...dedicatedEndpoints, ...catalogModels];
}

async function fetchServerlessCatalog(
  baseUrl: string,
  headers: Record<string, string>
): Promise<DiscoveredModel[]> {
  const res = await fetch(`${baseUrl}/models`, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Together /v1/models failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as TogetherModelsResponse;
  const entries: TogetherModelEntry[] = Array.isArray(json)
    ? json
    : Array.isArray(json.data)
      ? json.data
      : [];

  return entries.filter(isChatModel).map(normalize);
}

/**
 * The user's own dedicated endpoints — reserved-hardware deployments they
 * created themselves (e.g. for models like Hcompany/Holo3-35B-A3B that
 * Together doesn't serve on shared serverless infra at all). Surfaced
 * separately from the catalog because:
 *   - the catalog's bare model id (e.g. "Hcompany/Holo3-35B-A3B") is not
 *     callable once a model is dedicated-only; only the endpoint's `name`
 *     (e.g. "youruser/Hcompany/Holo3-35B-A3B-xxxxxxxx") is;
 *   - endpoints are user-specific and time-bound (billed while STARTED), so
 *     they can't be pre-baked into a static catalog the way serverless
 *     models can.
 * A non-2xx here (e.g. no endpoints scope, transient error) degrades to an
 * empty list rather than failing the whole discovery call — dedicated
 * endpoints are additive, not required for the picker to work.
 */
async function fetchDedicatedEndpoints(
  baseUrl: string,
  headers: Record<string, string>
): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch(`${baseUrl}/endpoints?type=dedicated&mine=true`, { headers });
    if (!res.ok) return [];
    const json = (await res.json()) as TogetherEndpointsResponse | TogetherEndpointEntry[];
    const entries: TogetherEndpointEntry[] = Array.isArray(json)
      ? json
      : Array.isArray(json.data)
        ? json.data
        : [];
    return entries.map(normalizeEndpoint);
  } catch {
    return [];
  }
}

function normalizeEndpoint(entry: TogetherEndpointEntry): DiscoveredModel {
  // `name` is the callable model string for chat completions; `model` is the
  // underlying base model id, kept only for family/capability inference.
  const callableId = entry.name;
  const baseModelId = entry.model;
  return {
    modelId: callableId,
    displayName: entry.display_name || baseModelId,
    description: `Dedicated endpoint (${entry.hardware ?? 'reserved hardware'}) for ${baseModelId}`,
    family: inferFamily(baseModelId),
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsTools: inferTools(baseModelId),
    supportsVision: inferVision(baseModelId),
    supportsReasoning: inferReasoning(baseModelId),
    isPreview: false,
    alreadyImported: false,
    endpointState: entry.state,
  };
}

function isChatModel(entry: TogetherModelEntry): boolean {
  // Together tags non-chat models with `type` (embedding, image, rerank,
  // moderation, audio, language). When `type` is missing, fall back to id
  // pattern matching.
  const embedding =
    entry.type === 'embedding' || (!entry.type && /embed|embedding/i.test(entry.id));
  const chat =
    entry.type === 'chat' ||
    (!entry.type &&
      !/embed|embedding|moderation|rerank|whisper|tts|stable-diffusion|flux/i.test(entry.id));
  return chat && !embedding;
}

function normalize(entry: TogetherModelEntry): DiscoveredModel {
  const id = entry.id;
  return {
    modelId: id,
    displayName: entry.display_name || id,
    family: inferFamily(id, entry.organization),
    contextWindowTokens: entry.context_length ?? null,
    maxOutputTokens: null,
    supportsTools: inferTools(id),
    supportsVision: inferVision(id),
    supportsReasoning: inferReasoning(id),
    isPreview: /preview|experimental|alpha|beta/i.test(id),
    alreadyImported: false,
  };
}

function inferFamily(modelId: string, organization?: string): string {
  const id = modelId.toLowerCase();
  if (/llama-?4/.test(id)) return 'llama-4';
  if (/llama-?3\.3/.test(id)) return 'llama-3.3';
  if (/llama-?3\.2/.test(id)) return 'llama-3.2';
  if (/llama-?3\.1/.test(id)) return 'llama-3.1';
  if (/llama-?3/.test(id)) return 'llama-3';
  if (/llama-?2/.test(id)) return 'llama-2';
  if (/qwen3/.test(id)) return 'qwen3';
  if (/qwen2\.5/.test(id)) return 'qwen-2.5';
  if (/qwen2/.test(id)) return 'qwen-2';
  if (/qwq/.test(id)) return 'qwq';
  if (/deepseek-?r1/.test(id)) return 'deepseek-r1';
  if (/deepseek-?v3/.test(id)) return 'deepseek-v3';
  if (/deepseek/.test(id)) return 'deepseek';
  if (/mixtral/.test(id)) return 'mixtral';
  if (/mistral/.test(id)) return 'mistral';
  if (/gemma-?3/.test(id)) return 'gemma-3';
  if (/gemma-?2/.test(id)) return 'gemma-2';
  if (/gemma/.test(id)) return 'gemma';
  if (/gpt-oss/.test(id)) return 'gpt-oss';
  if (/exaone/.test(id)) return 'exaone';
  if (/marin/.test(id)) return 'marin';
  return organization?.toLowerCase() || 'together';
}

function inferTools(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Tool-calling capable open-weight families on Together.
  if (/llama-?(3\.1|3\.2|3\.3|4)/.test(id)) return true;
  if (/qwen(2\.5|3)/.test(id)) return true;
  if (/qwq/.test(id)) return true;
  if (/deepseek-?(v3|r1)/.test(id)) return true;
  if (/mixtral|mistral-small|mistral-large|mistral-7b-instruct-v0\.[23]/.test(id)) return true;
  if (/gpt-oss/.test(id)) return true;
  return false;
}

function inferVision(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    /llama-?3\.2-(11b|90b)-vision/.test(id) ||
    /llama-?4/.test(id) ||
    /qwen2-?vl/.test(id) ||
    /qwen2\.5-?vl/.test(id) ||
    /pixtral/.test(id)
  );
}

function inferReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /deepseek-?r1|qwq|gpt-oss/.test(id);
}
