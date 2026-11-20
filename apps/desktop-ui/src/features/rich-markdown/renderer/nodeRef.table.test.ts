import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { chipHrefForNode } from '@desktop/utils/nodeChip';
import {
  NODE_HREF_SOURCE,
  PREFIXED_KINDS,
  idOnlyChipValue,
  parseNodeRef,
  tableChipHrefForBareId,
} from './nodeRef';

const CUSTOM_ID = 'table-1111111111111-aaaaaaaaa';
const BUILTIN_ID = 'table-builtin-docs';

describe('table chip hrefs', () => {
  it('parse `table:` hrefs for custom and built-in catalog ids', () => {
    expect(parseNodeRef(`table:${CUSTOM_ID}`)).toEqual({ kind: 'table', id: CUSTOM_ID });
    expect(parseNodeRef(`table:${BUILTIN_ID}`)).toEqual({ kind: 'table', id: BUILTIN_ID });
    const href = chipHrefForNode({ id: CUSTOM_ID, kind: 'table', title: 'Reading list' });
    expect(parseNodeRef(href)).toEqual({ kind: 'table', id: CUSTOM_ID });
  });

  it('reject a `table:` body that is not a catalog id', () => {
    expect(parseNodeRef('table:')).toBeNull();
    expect(parseNodeRef('table:reading-list')).toBeNull();
    expect(parseNodeRef('table:doc-1111111111111-aaaaaaaaa')).toBeNull();
    expect(parseNodeRef('table:table-builtin-')).toBeNull();
  });

  it('never treat a bare catalog id as a node ref, so prose `table-…` stays text', () => {
    expect(PREFIXED_KINDS as readonly string[]).not.toContain('table');
    expect(parseNodeRef(CUSTOM_ID)).toBeNull();
    expect(parseNodeRef(BUILTIN_ID)).toBeNull();
  });

  it('are matched by the node-href grammar only in their scheme form', () => {
    const re = new RegExp(`^${NODE_HREF_SOURCE}$`);
    expect(re.test(`table:${CUSTOM_ID}`)).toBe(true);
    expect(re.test(`table:${BUILTIN_ID}`)).toBe(true);
    expect(re.test(CUSTOM_ID)).toBe(false);
  });
});

describe('id-only table chip values', () => {
  it('store the bare catalog id and map it back to the chip href', () => {
    expect(idOnlyChipValue(`table:${CUSTOM_ID}`)).toBe(CUSTOM_ID);
    expect(tableChipHrefForBareId(CUSTOM_ID)).toBe(`table:${CUSTOM_ID}`);
    expect(tableChipHrefForBareId(BUILTIN_ID)).toBe(`table:${BUILTIN_ID}`);
  });

  it('leave every other chip href as is', () => {
    const docId = 'doc-1111111111111-aaaaaaaaa';
    expect(idOnlyChipValue(docId)).toBe(docId);
    expect(idOnlyChipValue('model:provider/model')).toBe('model:provider/model');
    expect(idOnlyChipValue('table:not-a-table')).toBe('table:not-a-table');
    expect(tableChipHrefForBareId(docId)).toBeNull();
  });
});
