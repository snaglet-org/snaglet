import { describe, expect, it } from '@jest/globals';
import {
  renderEntries,
  renderEntryPage,
  renderWrite,
} from '@server/services/ToolService/tools/database/_shared/render';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const LINK = `link a row: [title](entry:${TABLE_ID}/<entry id>)`;

describe('table results say how to link a row', () => {
  it('a read by ids names the table id in the entry chip form', () => {
    const out = renderEntries({
      table: 'Tasks',
      tableId: TABLE_ID,
      entries: [{ id: ENTRY_ID, rev: 'abcdef12', values: { name: 'x' } }],
      missing: [],
    });
    expect(out).toContain(LINK);
  });

  it('a paged read names it too', () => {
    const out = renderEntryPage({
      table: 'Tasks',
      tableId: TABLE_ID,
      entries: [{ id: ENTRY_ID, rev: 'abcdef12', values: { name: 'x' } }],
      page: 1,
      pageSize: 25,
      total: 1,
      hasMore: false,
      schemaVersion: 'v1',
    });
    expect(out).toContain(LINK);
  });

  it('a write that touched rows names it, and "no changes" does not', () => {
    const touched = renderWrite({
      tableId: TABLE_ID,
      inserted: [{ id: ENTRY_ID, rev: 'abcdef12' }],
      existing: [],
      updated: [],
      unchanged: [],
    });
    expect(touched).toContain(LINK);
    const none = renderWrite({
      tableId: TABLE_ID,
      inserted: [],
      existing: [],
      updated: [],
      unchanged: [],
    });
    expect(none).toBe('no changes');
  });

  it('an empty page has no rows to link, so no line', () => {
    const out = renderEntryPage({
      table: 'Tasks',
      tableId: TABLE_ID,
      entries: [],
      page: 1,
      pageSize: 25,
      total: 0,
      hasMore: false,
      schemaVersion: 'v1',
    });
    expect(out).not.toContain('link a row');
  });
});
