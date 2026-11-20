/**
 * The models a subagent helper can run on, shared by the `subagent` tool
 * (which validates the choice) and the system prompt (which lists them), so
 * the two can never disagree.
 */
import { Models, type ModelRow } from '@snaglet/db/tables/models';
import { Agents } from '@snaglet/db/tables/agents';
import { Threads } from '@snaglet/db/tables/threads';

/**
 * The provider a helper of `agentId` runs on in `threadId`: the agent's own
 * effective provider there (a participant override first), never a fallback.
 */
export async function helperProviderId(
  threadId: string,
  agentId: string,
  agentProviderId: string | null | undefined
): Promise<string | null> {
  const effective = await Threads.getEffectiveModel(threadId, agentId);
  return effective?.providerId ?? agentProviderId ?? null;
}

/** Models a helper can run on: active, tool-capable chat models of one provider. */
export async function helperModels(providerId: string): Promise<ModelRow[]> {
  const rows = await Models.listActiveByProviderId(providerId);
  return rows.filter((m) => m.supportsTools && (m.type === 'llm' || m.type === 'chat'));
}

/** A requested model by id, `provider:model` id or display name (case-insensitive). */
export function matchModel(models: ModelRow[], wanted: string): ModelRow | undefined {
  const w = wanted.trim().toLowerCase();
  return (
    models.find((m) => m.modelId.toLowerCase() === w) ??
    models.find((m) => m.id.toLowerCase() === w) ??
    models.find((m) => m.displayName.toLowerCase() === w)
  );
}

/** One line of model ids (with display names) for an error message. */
export function describeModels(models: ModelRow[]): string {
  const shown = models
    .slice(0, 40)
    .map((m) =>
      m.displayName && m.displayName !== m.modelId ? `${m.modelId} (${m.displayName})` : m.modelId
    );
  const more = models.length > shown.length ? ` … and ${models.length - shown.length} more` : '';
  return shown.join(', ') + more;
}

const NO_MODELS =
  'No tool-capable model is active on your provider, so a helper cannot start until one is.';

function contextLabel(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M context`;
  return `${Math.round(tokens / 1000)}k context`;
}

/**
 * One line per distinct display name (a dated snapshot shares its alias's
 * display name: the first of each is listed, `start` takes both ids), with the
 * context window, reasoning and vision tags, and the caller's own model marked.
 */
export function describeModelsDetailed(models: ModelRow[], currentModelId: string | null): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of models) {
    const name = (m.displayName || m.modelId).toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const parts = [m.modelId];
    const context = contextLabel(m.contextWindowTokens);
    if (context) parts.push(context);
    if (m.supportsReasoning) parts.push('reasoning');
    if (m.supportsVision) parts.push('vision');
    if (m.modelId === currentModelId) parts.push('your model');
    lines.push(`- ${parts.join(' · ')}`);
  }
  return `${lines.join('\n')}\nPass any listed id, or its dated snapshot id, as model.`;
}

/** What `subagent` op "models" returns: the caller's provider's helper models, or why there are none. */
export async function describeHelperModels(threadId: string, agentId: string): Promise<string> {
  const [agent, effective] = await Promise.all([
    Agents.findById(agentId),
    Threads.getEffectiveModel(threadId, agentId),
  ]);
  const providerId = effective?.providerId ?? agent?.providerId ?? null;
  if (!providerId) return NO_MODELS;
  const models = await helperModels(providerId);
  if (models.length === 0) return NO_MODELS;
  const current = effective?.modelId ?? agent?.modelId ?? null;
  return `Models on your provider (${providerId}):\n${describeModelsDetailed(models, current)}`;
}
