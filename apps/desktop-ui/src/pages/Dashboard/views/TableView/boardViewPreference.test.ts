import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField } from '@snaglet/shared/types';
import {
  boardCandidateFields,
  boardUnavailableReason,
  readBoardFieldId,
  readTableViewMode,
  resolveBoardField,
  writeBoardFieldId,
  writeTableViewMode,
} from './boardViewPreference';

const tableId = 'table-1111111111111-aaaaaaaaa';
const base: TableField = {
  range: false,
  id: 'field-1111111111111-name',
  tableId,
  columnName: 'name',
  name: 'Name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  multiple: false,
  options: null,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: true,
  revision: 1,
};
const status: TableField = {
  ...base,
  id: 'field-1111111111111-status',
  columnName: 'status',
  name: 'Status',
  type: 'select',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  options: [{ id: 'opt-a', label: 'A', color: 'gray' }],
};
const priority: TableField = {
  ...status,
  id: 'field-1111111111111-priority',
  columnName: 'priority',
  name: 'Priority',
};
const tags: TableField = {
  ...status,
  id: 'field-1111111111111-tags',
  columnName: 'tags',
  name: 'Tags',
  multiple: true,
  defaultValue: [],
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('table view preference', () => {
  it('defaults to Grid and remembers Board per table', () => {
    expect(readTableViewMode(tableId)).toBe('grid');
    writeTableViewMode(tableId, 'board');
    expect(readTableViewMode(tableId)).toBe('board');
    expect(readTableViewMode('table-2222222222222-bbbbbbbbb')).toBe('grid');
    writeTableViewMode(tableId, 'grid');
    expect(readTableViewMode(tableId)).toBe('grid');
    expect(localStorage.length).toBe(0);
  });

  it('remembers the Board field per table', () => {
    expect(readBoardFieldId(tableId)).toBeNull();
    writeBoardFieldId(tableId, priority.id);
    expect(readBoardFieldId(tableId)).toBe(priority.id);
    writeBoardFieldId(tableId, null);
    expect(readBoardFieldId(tableId)).toBeNull();
  });

  it('falls back to Grid when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTableViewMode(tableId)).toBe('grid');
    expect(readBoardFieldId(tableId)).toBeNull();
    expect(() => writeTableViewMode(tableId, 'board')).not.toThrow();
    expect(() => writeBoardFieldId(tableId, status.id)).not.toThrow();
  });
});

describe('Board field candidates', () => {
  it('offers single-choice selects only', () => {
    expect(boardCandidateFields([base, status, tags, priority]).map((f) => f.name)).toEqual([
      'Status',
      'Priority',
    ]);
  });

  it('explains why the Board is unavailable', () => {
    expect(boardUnavailableReason([base])).toBe('Add a select field to use Board');
    expect(boardUnavailableReason([base, tags])).toBe('Board needs a single-choice select field');
    expect(boardUnavailableReason([base, status])).toBeNull();
  });

  it('resolves the remembered field while it exists, else the first candidate', () => {
    expect(resolveBoardField([base, status, priority], priority.id)?.id).toBe(priority.id);
    expect(resolveBoardField([base, status, priority], 'field-1111111111111-gone')?.id).toBe(
      status.id
    );
    expect(resolveBoardField([base, status], null)?.id).toBe(status.id);
    expect(resolveBoardField([base, tags], status.id)).toBeNull();
  });
});
