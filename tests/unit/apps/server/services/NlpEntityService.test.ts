/**
 * NlpEntityService.syncMessageEntities — the write hook that folds NLP
 * entities into messages.search_text. Mocks the nlp facade (extractEntities)
 * and the Messages model so this exercises only the hook's own decision
 * logic: call the SQL write when entities are present, skip it when they're
 * not (the empty-entities/fallback contract), and never throw regardless of
 * what extractEntities resolves.
 */

const mockExtractEntities = jest.fn();
jest.mock('@server/services/nlp', () => ({
  extractEntities: (text: string) => mockExtractEntities(text),
}));

const mockUpdateSearchEntityTerms = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    updateSearchEntityTerms: (...args: unknown[]) => mockUpdateSearchEntityTerms(...args),
  },
}));

import { afterAll, describe, expect, it, beforeEach, jest } from '@jest/globals';
import { syncMessageEntities } from '@server/services/NlpEntityService';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

describe('syncMessageEntities', () => {
  beforeEach(() => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
    mockExtractEntities.mockReset();
    mockUpdateSearchEntityTerms.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  it('does not launch entity extraction for an ordinary message by default', async () => {
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;

    await syncMessageEntities('msg-quiet', 'Jane Doe met Acme Corp');

    expect(mockExtractEntities).not.toHaveBeenCalled();
    expect(mockUpdateSearchEntityTerms).not.toHaveBeenCalled();
  });

  it('writes the extracted entities to search_entity_terms when present', async () => {
    mockExtractEntities.mockResolvedValue({ entities: ['Jane Doe', 'Acme Corp'], language: 'en' });

    await syncMessageEntities('msg-1', 'Jane Doe met with Acme Corp yesterday.');

    expect(mockExtractEntities).toHaveBeenCalledWith('Jane Doe met with Acme Corp yesterday.');
    expect(mockUpdateSearchEntityTerms).toHaveBeenCalledTimes(1);
    // Only the entity terms are written. The content half of the vector is
    // maintained by the generated column, so passing content here would be
    // both redundant and a way to write a vector that disagrees with the row.
    expect(mockUpdateSearchEntityTerms).toHaveBeenCalledWith('msg-1', ['Jane Doe', 'Acme Corp']);
  });

  it('skips the write when extraction resolves zero entities (fallback path)', async () => {
    // The shape extractEntities resolves on non-mac/CI/unbuilt helper, and for
    // a real message with no recognizable names. Skipping is purely a saved
    // UPDATE: the content half of search_text is a generated column, so the
    // message is fully indexed either way.
    mockExtractEntities.mockResolvedValue({ entities: [], language: null });

    await syncMessageEntities('msg-2', 'no names in here');

    expect(mockUpdateSearchEntityTerms).not.toHaveBeenCalled();
  });

  it('propagates a DB write failure to the caller (chatHandlers.ts supplies the catch)', async () => {
    mockExtractEntities.mockResolvedValue({ entities: ['X'], language: null });
    mockUpdateSearchEntityTerms.mockReset().mockRejectedValue(new Error('db write failed'));

    await expect(syncMessageEntities('msg-3', 'has an X entity')).rejects.toThrow(
      'db write failed'
    );
  });

  it('never calls the DB when extractEntities itself resolves the empty fallback', async () => {
    // extractEntities is documented to never throw — it resolves the empty
    // fallback on every failure mode (absent binary, ENOENT, crash, timeout).
    // The hook must treat that exactly like "no entities found": skip.
    mockExtractEntities.mockResolvedValue({ entities: [], language: null });

    await expect(syncMessageEntities('msg-4', 'anything')).resolves.toBeUndefined();
    expect(mockUpdateSearchEntityTerms).not.toHaveBeenCalled();
  });
});
