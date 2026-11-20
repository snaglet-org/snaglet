import { describe, test, expect } from '@jest/globals';
import { tokenizeQuery } from '../../../../../../packages/db/tables/tools/tokenize';

describe('tokenizeQuery fallback splitter', () => {
  test('returns [] for empty input', () => {
    expect(tokenizeQuery('')).toEqual([]);
  });

  test('splits on underscore', () => {
    expect(tokenizeQuery('library_get_page')).toEqual(['library', 'get', 'page']);
  });

  test('splits on hyphen', () => {
    expect(tokenizeQuery('search-tools')).toEqual(['search', 'tools']);
  });

  test('splits on whitespace', () => {
    expect(tokenizeQuery('search   tools')).toEqual(['search', 'tools']);
  });

  test('splits camelCase boundaries', () => {
    expect(tokenizeQuery('readFile')).toEqual(['read', 'file']);
    expect(tokenizeQuery('listAvailableTools')).toEqual(['list', 'available', 'tools']);
  });

  test('combines mixed separators correctly', () => {
    expect(tokenizeQuery('libraryRead_page')).toEqual(['library', 'read', 'page']);
  });

  test('drops tokens shorter than 3 chars', () => {
    // 'to' gets dropped (len 2)
    expect(tokenizeQuery('post_to_feed')).toEqual(['post', 'feed']);
    expect(tokenizeQuery('a_b_create')).toEqual(['create']);
  });

  test('lowercases all tokens', () => {
    expect(tokenizeQuery('BROWSE_FEED')).toEqual(['browse', 'feed']);
    expect(tokenizeQuery('CheckInbox')).toEqual(['check', 'inbox']);
  });

  test('de-duplicates while preserving first-seen order', () => {
    expect(tokenizeQuery('read_page_read')).toEqual(['read', 'page']);
    expect(tokenizeQuery('feed_browse_feed')).toEqual(['feed', 'browse']);
  });

  test('digits-then-caps acts as a boundary', () => {
    // 'v2' is len 2, dropped
    expect(tokenizeQuery('v2Tool')).toEqual(['tool']);
    expect(tokenizeQuery('api2Call')).toEqual(['api2', 'call']);
  });

  test('cluster-realistic hallucinations tokenize sensibly', () => {
    // These are actual fake names from the cluster doc. Each must produce
    // tokens that overlap with the real tool's name/keywords for Layer 3
    // to resolve them.
    expect(tokenizeQuery('library_page_read')).toEqual(['library', 'page', 'read']);
    expect(tokenizeQuery('feed_browse')).toEqual(['feed', 'browse']);
    expect(tokenizeQuery('run_command')).toEqual(['run', 'command']);
    expect(tokenizeQuery('save_memory')).toEqual(['save', 'memory']);
    expect(tokenizeQuery('list_conversations')).toEqual(['list', 'conversations']);
  });
});
