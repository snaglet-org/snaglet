import { describe, expect, it } from 'vitest';
import { parseEntryChipId, nodeToChipMarkdown, chipHrefForNode, isChipKind } from '.';
import { parseNodeRef, NODE_HREF_SOURCE } from '@desktop/features/rich-markdown/renderer/nodeRef';

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = `${tableId}/${entryId}`;

describe('entry chip identity', () => {
  it('round-trips a canonical custom table/UUID identity and normalizes UUID case', () => {
    expect(isChipKind('entry')).toBe(true);
    expect(parseEntryChipId(`${tableId}/${entryId.toUpperCase()}`)).toEqual({ tableId, entryId });
    expect(chipHrefForNode({ kind: 'entry', id })).toBe(`entry:${id}`);
    expect(parseNodeRef(`entry:${id}`)).toEqual({ kind: 'entry', id });
    expect(new RegExp(`^${NODE_HREF_SOURCE}$`).test(`entry:${id}`)).toBe(true);
  });

  it.each([
    `table-builtin-docs/${entryId}`,
    `${tableId}/not-a-uuid`,
    `${id}/extra`,
    `table-1111111111111-aaaaaaaaa`,
    // A bare entry uuid has no table: UUIDs can repeat across tables, so it is not a chip.
    entryId,
  ])('rejects invalid entry identity %s', (value) => {
    expect(parseEntryChipId(value)).toBeNull();
    expect(parseNodeRef(`entry:${value}`)).toBeNull();
  });

  it('keeps unnamed references empty and sanitizes only the stored label', () => {
    expect(nodeToChipMarkdown({ kind: 'entry', id })).toBe(`[](entry:${id})`);
    expect(nodeToChipMarkdown({ kind: 'entry', id, title: '[Draft] \\ plan\nnext' })).toBe(
      `[\\[Draft\\] \\\\ plan next](entry:${id})`
    );
  });
});
