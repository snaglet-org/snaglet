import { describe, expect, it } from 'vitest';
import type { TableField, TableReferenceKind } from '@snaglet/shared/types';
import type { NodeChipData } from '@desktop/utils/nodeChip';
import { chipDropProblem, relatedChipEntryId } from './chipDrop';

const base: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'link',
  name: 'link',
  description: null,
  type: 'relation',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: 'doc',
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const linking = (referenceKind: TableReferenceKind): TableField => ({ ...base, referenceKind });
const chip = (kind: NodeChipData['kind'], id: string): NodeChipData => ({
  kind,
  id,
  title: 'Title',
});

describe('chips dropped on relations to Snaglet items', () => {
  it('accepts a chip of the field kind as its id, containers for either container kind', () => {
    expect(relatedChipEntryId(linking('doc'), chip('doc', 'doc-1'))).toBe('doc-1');
    expect(relatedChipEntryId(linking('agent'), chip('agent', 'test-agent-a'))).toBe(
      'test-agent-a'
    );
    expect(relatedChipEntryId(linking('project'), chip('container', 'container-1'))).toBe(
      'container-1'
    );
    expect(relatedChipEntryId(linking('container'), chip('project', 'container-2'))).toBe(
      'container-2'
    );
  });

  it('refuses other chips with a reason naming the kind', () => {
    expect(relatedChipEntryId(linking('doc'), chip('thread', 'thread-1'))).toBeNull();
    expect(
      relatedChipEntryId(
        linking('doc'),
        chip('entry', 'table-1111111111111-aaaaaaaaa/11111111-1111-4111-8111-111111111111')
      )
    ).toBeNull();
    expect(chipDropProblem(linking('doc'), chip('thread', 'thread-1'))).toBe(
      'This field links to docs. Drop a doc here.'
    );
    expect(chipDropProblem(linking('agent'))).toBe(
      'This field links to agents. Drop an agent here.'
    );
  });
});
