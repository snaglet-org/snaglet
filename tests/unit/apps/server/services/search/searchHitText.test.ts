/**
 * searchHitText — the text the cross-encoder reranker judges each hit by.
 * Pins the every-kind coverage contract: a SearchHit kind whose text lives
 * under a field name missing from HIT_TEXT_FIELDS gets judged as its bare
 * kind string and systematically sinks (the summary/file/memory-key
 * sinking bug). Each case asserts the kind's real fields make it into
 * the reranker text.
 */

import { describe, expect, it } from '@jest/globals';
import { searchHitText } from '@server/services/ToolService/handlers/search/workspaceSearch/rerankHits';
import type { SearchHit } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

describe('searchHitText', () => {
  it('thread summaries are judged by their summary text and thread title', () => {
    const hit = {
      kind: 'thread_summary',
      id: 'ts-1',
      threadId: 'thread-1',
      threadTitle: 'Embeddings rework plan',
      agentId: null,
      summaryText: 'Planned the retrieval rework slices and eval-first approach.',
      updatedAt: 'now',
    } as unknown as SearchHit;
    const text = searchHitText(hit);
    expect(text).toContain('Embeddings rework plan');
    expect(text).toContain('retrieval rework slices');
    expect(text).not.toBe('thread_summary');
  });

  it('file hits are judged by their relative path', () => {
    const hit = {
      kind: 'file',
      id: 'file-1',
      relativePath: 'apps/server/src/services/search/candidateCards.ts',
      projectId: 'p1',
      sizeBytes: 1,
      updatedAt: 'now',
    } as unknown as SearchHit;
    expect(searchHitText(hit)).toContain('candidateCards.ts');
  });

  it('memory hits are judged by key and content', () => {
    const hit = {
      kind: 'memory',
      id: 'mem-1',
      key: 'snaglet_hnsw_proof_and_rewrite_contract',
      content: 'ef_search caps the candidate pool.',
      agentId: null,
      sourceThreadId: null,
      updatedAt: 'now',
    } as unknown as SearchHit;
    const text = searchHitText(hit);
    expect(text).toContain('snaglet_hnsw_proof_and_rewrite_contract');
    expect(text).toContain('ef_search');
  });

  it('docs/messages/tasks keep their existing fields', () => {
    expect(
      searchHitText({
        kind: 'doc',
        id: 'd1',
        title: 'Plan doc',
        updatedAt: '',
        rank: 1,
        snippet: 'the plan body',
      } as unknown as SearchHit)
    ).toContain('Plan doc');
    expect(
      searchHitText({
        kind: 'task',
        id: 't1',
        title: 'Fix reranker',
        description: 'field mapping',
        status: 'backlog',
        priority: null,
        projectId: null,
        updatedAt: '',
      } as unknown as SearchHit)
    ).toContain('field mapping');
  });

  it('falls back to the kind string only when a hit truly has no text', () => {
    expect(searchHitText({ kind: 'image', id: 'i1' } as unknown as SearchHit)).toBe('image');
  });
});
