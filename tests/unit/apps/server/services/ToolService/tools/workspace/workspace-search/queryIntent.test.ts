/**
 * queryIntent.ts — deterministic thread-recall triggers. Conversation-recall
 * queries route to the thread-summary channel; everything else does not.
 */

import { describe, expect, it } from '@jest/globals';
import { isThreadRecallQuery } from '@server/services/ToolService/handlers/search/workspaceSearch/queryIntent';

describe('isThreadRecallQuery', () => {
  it.each([
    'that thread where we picked the vector model',
    'the conversation about pricing',
    'our chat yesterday about deploys',
    'when we talked about retries',
  ])('keeps firing for conversation recall %p', (query) => {
    expect(isThreadRecallQuery(query)).toBe(true);
  });

  it.each(['retry backoff decision', 'a doc about caching', 'postgres migration plan'])(
    'does not fire without recall words %p',
    (query) => {
      expect(isThreadRecallQuery(query)).toBe(false);
    }
  );
});
