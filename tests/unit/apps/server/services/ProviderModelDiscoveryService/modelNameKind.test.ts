import { describe, expect, it } from '@jest/globals';
import {
  isRerankerModelName,
  isEmbeddingModelName,
} from '@server/services/ProviderModelDiscoveryService/modelNameKind';

describe('modelNameKind', () => {
  describe('isRerankerModelName', () => {
    it('returns true for reranker model names', () => {
      expect(isRerankerModelName('bge-reranker-v2-m3')).toBe(true);
      expect(isRerankerModelName('jina-reranker-v2-base')).toBe(true);
      expect(isRerankerModelName('mxbai-rerank-large-v1')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isRerankerModelName('BGE-RERANKER-v2-m3')).toBe(true);
      expect(isRerankerModelName('JINA-RERANKER-v2-base')).toBe(true);
    });

    it('returns false for non-reranker models', () => {
      expect(isRerankerModelName('llama3.1')).toBe(false);
      expect(isRerankerModelName('nomic-embed-text')).toBe(false);
      expect(isRerankerModelName('text-embedding-3-small')).toBe(false);
    });
  });

  describe('isEmbeddingModelName', () => {
    it('returns true for embedding model names', () => {
      expect(isEmbeddingModelName('nomic-embed-text')).toBe(true);
      expect(isEmbeddingModelName('text-embedding-3-small')).toBe(true);
      expect(isEmbeddingModelName('mxbai-embed-large')).toBe(true);
      expect(isEmbeddingModelName('bge-m3')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isEmbeddingModelName('NOMIC-EMBED-TEXT')).toBe(true);
      expect(isEmbeddingModelName('TEXT-EMBEDDING-3-SMALL')).toBe(true);
    });

    it('returns false for reranker models even if they match the pattern', () => {
      expect(isEmbeddingModelName('bge-reranker-v2-m3')).toBe(false);
      expect(isEmbeddingModelName('jina-reranker-v2-base')).toBe(false);
    });

    it('returns false for chat model names', () => {
      expect(isEmbeddingModelName('llama3.1')).toBe(false);
      expect(isEmbeddingModelName('qwen2.5')).toBe(false);
      expect(isEmbeddingModelName('gpt-4')).toBe(false);
    });
  });
});
