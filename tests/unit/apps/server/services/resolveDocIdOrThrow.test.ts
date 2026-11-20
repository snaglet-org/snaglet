/**
 * resolveDocIdOrThrow — the shared id-or-path preamble for docs tools.
 * Pins the two guards and the id passthrough (the doc_path branch resolves
 * via the DB and is covered by the docs tools' integration behavior).
 */

import { describe, expect, it } from '@jest/globals';
import { resolveDocIdOrThrow } from '@server/services/WorkspaceService/pathResolver';

describe('resolveDocIdOrThrow', () => {
  it('throws when neither doc_id nor doc_path is given', async () => {
    await expect(resolveDocIdOrThrow({})).rejects.toThrow('Must specify either doc_id or doc_path');
  });

  it('throws when both doc_id and doc_path are given', async () => {
    await expect(
      resolveDocIdOrThrow({ doc_id: 'doc-1', doc_path: '/Snaglet/notes' })
    ).rejects.toThrow('Cannot specify both doc_id and doc_path');
  });

  it('passes a doc_id through without touching path resolution', async () => {
    await expect(resolveDocIdOrThrow({ doc_id: 'doc-42' })).resolves.toBe('doc-42');
  });
});
