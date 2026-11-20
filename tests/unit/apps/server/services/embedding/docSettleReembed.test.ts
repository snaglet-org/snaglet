import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn();
const embedDocNow = jest.fn();

jest.mock('@snaglet/db', () => ({ getDb: () => ({ query }) }));
jest.mock('@server/services/embedding/embedDoc', () => ({
  // docBlobForEmbedding is used by stampDocEdit's hash; keep the real join shape.
  docBlobForEmbedding: (title?: string | null, content?: string | null) =>
    [title?.trim() ?? '', content?.trim() ?? ''].filter((p) => p.length > 0).join('\n\n'),
  embedDocNow: (...args: unknown[]) => embedDocNow(...args),
}));

import { sweepSettledDocReembeds } from '@server/services/embedding/docSettleReembed';

const settledRow = {
  doc_id: 'doc-1',
  title: 'Quiet edit',
  content: 'changed body',
  content_hash: 'hash-2',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('settled human doc edit re-embed sweep', () => {
  it('re-embeds a doc whose human edit has settled, then advances the embedded marker', async () => {
    // First query: the settled-rows SELECT. Second: the marker UPDATE.
    query.mockResolvedValueOnce({ rows: [settledRow] }).mockResolvedValueOnce({ rows: [] });

    await expect(sweepSettledDocReembeds()).resolves.toBe(1);

    // The settled edit is re-embedded from the same blob the autosave deferred.
    expect(embedDocNow).toHaveBeenCalledWith('doc-1', 'Quiet edit', 'changed body');
    // The last-embedded marker advances to exactly the hash we embedded.
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE public.doc_edit_state'),
      ['doc-1', 'hash-2']
    );
  });

  it('does nothing when no doc edit has settled', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(sweepSettledDocReembeds()).resolves.toBe(0);
    expect(embedDocNow).not.toHaveBeenCalled();
  });

  it('only selects docs that changed since last embedded and have gone idle', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await sweepSettledDocReembeds();

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('content_hash IS DISTINCT FROM s.last_logged_hash');
    expect(sql).toContain('last_content_edit_at <');
  });
});
