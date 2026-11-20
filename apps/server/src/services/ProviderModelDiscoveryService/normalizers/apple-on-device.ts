/**
 * apple-on-device model discovery — trivial normalizer.
 *
 * Unlike ollama/lm-studio (an HTTP call against a local daemon's live model
 * list), FoundationModels exposes exactly ONE fixed on-device model with no
 * enumeration endpoint at all — so there is nothing to fetch. This just
 * reports that single model with its fixed metadata (4096-token context
 * window — see the seed migration and ContextWindowService's
 * PROVIDER_SAFETY_MARGIN_PCT comment for why that number is a hard, real
 * ceiling and not an inferred/optimistic one like the ollama/lm-studio
 * normalizers compute from a model-id string).
 */
import type { DiscoveredModel } from '../types';

const APPLE_ON_DEVICE_MODEL_ID = 'apple-on-device';

export async function discoverAppleOnDeviceModels(): Promise<DiscoveredModel[]> {
  const model: DiscoveredModel = {
    modelId: APPLE_ON_DEVICE_MODEL_ID,
    displayName: 'Apple On-Device (~3B)',
    description: "Apple's on-device FoundationModels LLM. 4096-token total context window.",
    family: 'apple-foundation',
    contextWindowTokens: 4096,
    maxOutputTokens: 1024,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    alreadyImported: false,
  };
  return [model];
}
