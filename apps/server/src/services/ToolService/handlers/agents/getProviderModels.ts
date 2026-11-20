/**
 * get_provider_models — discover the chat-model catalog for one provider.
 *
 * Delegates to ProviderModelDiscoveryService.discoverModels, which queries the
 * provider's live /models endpoint, normalizes the result, and joins against
 * the local models table to flag already-imported models. Embedding models are
 * never listed: Snaglet embeds with its one built-in local model.
 */
import { discoverModels } from '@server/services/ProviderModelDiscoveryService';
import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';

interface GetProviderModelsInput {
  provider_id?: unknown;
  model_kind?: unknown;
}

const handler: ToolHandler = async (input) => {
  const args = (input ?? {}) as GetProviderModelsInput;

  const providerId = asNonEmptyString(args.provider_id);
  if (!providerId) {
    return { output: 'get_provider_models: `provider_id` is required (non-empty string).' };
  }

  // A caller may still send `model_kind: "chat"`; that is harmless.
  if (args.model_kind != null && args.model_kind !== 'chat') {
    return {
      output:
        'get_provider_models: only chat models can be listed. Snaglet embeds with its built-in local ' +
        'model, so `model_kind: "embedding"` is not supported.',
    };
  }

  const result = await discoverModels(providerId);

  if (result.models.length === 0) {
    const reason = result.warning ?? 'No models returned by discovery.';
    return {
      output: `No chat models found for provider "${providerId}". ${reason}`,
      rawContent: result,
    };
  }

  const lines = result.models.map((m) => {
    const caps: string[] = [];
    if (m.supportsTools) caps.push('tools');
    if (m.supportsVision) caps.push('vision');
    if (m.supportsReasoning) caps.push('reasoning');
    const capStr = caps.length ? ` [${caps.join(', ')}]` : '';
    const imported = m.alreadyImported ? ' (imported)' : '';
    return `- ${m.modelId} — ${m.displayName}${capStr}${imported}`;
  });

  const warning = result.warning ? `\nWarning: ${result.warning}` : '';

  return {
    output: `${result.models.length} chat model(s) for "${providerId}":\n${lines.join('\n')}${warning}`,
    rawContent: result,
  };
};

export default handler;
