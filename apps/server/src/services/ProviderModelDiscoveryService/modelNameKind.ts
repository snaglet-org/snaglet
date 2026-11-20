/**
 * Model name classification — detect embedding and reranker models by name
 * as a fallback when capabilities are unavailable.
 */

const RERANKER_NAME_RE = /rerank/i;
const EMBEDDING_NAME_RE = /embed|embedding|bge/i;

/**
 * Test if a model name suggests it is a reranker model.
 * Rerankers are neither embeddings nor chat models; discovery leaves them out.
 */
export function isRerankerModelName(name: string): boolean {
  return RERANKER_NAME_RE.test(name);
}

/**
 * Test if a model name suggests it is an embedding model.
 * Returns false for reranker names even if they match the embedding pattern.
 */
export function isEmbeddingModelName(name: string): boolean {
  if (isRerankerModelName(name)) return false;
  return EMBEDDING_NAME_RE.test(name);
}
