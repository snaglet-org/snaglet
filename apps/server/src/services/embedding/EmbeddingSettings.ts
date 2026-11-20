/**
 * EmbeddingSettings — the active embedding model, as a fixed constant. Snaglet
 * embeds with exactly one built-in local model; the settings-style facade
 * serves status surfaces (health, banners, the maintenance view), and
 * `getActiveModel()` never returns null.
 */

import {
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
} from './embedderModelManifest';

export interface ActiveEmbeddingModel {
  providerId: string;
  modelId: string;
  dimensions: number;
}

const LOCAL_ACTIVE_MODEL: ActiveEmbeddingModel = {
  providerId: LOCAL_EMBEDDER_PROVIDER_ID,
  modelId: LOCAL_EMBEDDER_MODEL_ID,
  dimensions: LOCAL_EMBEDDER_DIMENSIONS,
};

export const embeddingSettings = {
  /** The always-on built-in local embedding model. */
  async getActiveModel(): Promise<ActiveEmbeddingModel> {
    return LOCAL_ACTIVE_MODEL;
  },
};
