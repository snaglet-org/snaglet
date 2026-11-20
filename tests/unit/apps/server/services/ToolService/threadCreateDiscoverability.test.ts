/**
 * thread_create discoverability: agents searching "create a new thread" /
 * "start thread" must find it. Pins the two data levers: `aliases` (resolved
 * back to thread_create by get_tool_schema via Tools.findByAlias, persisted to
 * the tools row by upsertTool) and phrase + single-word `keywords` (matched by
 * search_tools' whole-query keyword pass and its tokenized fallback).
 */

import definition from '@server/services/ToolService/tools/threads/thread/definition';
import { resolveToolId } from '@snaglet/shared/utils';

describe('thread create discoverability contract (thread(op))', () => {
  test('create lives on the merged thread tool', () => {
    expect(definition.id).toBe('thread');
    expect(resolveToolId('thread_create')).toMatchObject({ id: 'thread', op: 'create' });
  });

  test('exposes the create/new/start alias phrasings', () => {
    for (const alias of ['create_thread', 'new_thread', 'start_thread']) {
      expect(definition.aliases).toContain(alias);
      expect(resolveToolId(alias)).toMatchObject({ id: 'thread', op: 'create' });
    }
  });

  test('keywords cover the multi-word queries the keyword pass matches whole', () => {
    for (const phrase of ['create a new thread', 'start thread', 'new thread']) {
      expect(definition.keywords).toContain(phrase);
    }
  });

  test('keywords cover the single tokens the tokenized fallback scores on', () => {
    for (const token of ['thread', 'create', 'new', 'start', 'conversation']) {
      expect(definition.keywords).toContain(token);
    }
  });
});
