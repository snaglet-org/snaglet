import { describe, expect, it } from '@jest/globals';
import {
  TABLE_REFERENCE_KINDS,
  type TableField,
  type TableFieldDefinition,
} from '@snaglet/shared/types';
import {
  isTableReferenceKind,
  tableEntryValueProblem,
  tableFieldDefinitionProblem,
  tableReferenceChip,
  tableReferenceIdsInText,
  tableReferenceKindArticle,
  unwrapTableReferenceChip,
} from '@snaglet/shared/utils';

const DOC_A = 'doc-1111111111111-aaaaaaaaa';
const DOC_B = 'doc-1111111111111-bbbbbbbbb';

const relation: TableFieldDefinition = {
  name: 'brief',
  description: null,
  type: 'relation',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: 'doc',
};

describe('relation definitions with a Snaglet item kind', () => {
  it('accepts every allowlisted kind, single or multiple', () => {
    for (const referenceKind of TABLE_REFERENCE_KINDS) {
      expect(tableFieldDefinitionProblem({ ...relation, referenceKind })).toBeNull();
      expect(
        tableFieldDefinitionProblem({
          ...relation,
          referenceKind,
          multiple: true,
          nullable: false,
          defaultValue: [],
        })
      ).toBeNull();
    }
    expect(isTableReferenceKind('calendar_event')).toBe(false);
    expect(isTableReferenceKind('credential')).toBe(false);
  });

  it('needs exactly one target and a known kind', () => {
    expect(
      tableFieldDefinitionProblem({
        ...relation,
        referenceTableId: 'table-1111111111111-aaaaaaaaa',
      })
    ).toContain('not both');
    expect(tableFieldDefinitionProblem({ ...relation, referenceKind: null })).toBe(
      'Choose what this relation links to: a table or a Snaglet item type.'
    );
    expect(
      tableFieldDefinitionProblem({
        ...relation,
        referenceKind: 'credential' as TableFieldDefinition['referenceKind'],
      })
    ).toContain('doc, project, container, thread, image, agent');
    // Left out, the kind is undecided (an update keeps the field's own).
    const { referenceKind: _kind, ...undecided } = relation;
    expect(tableFieldDefinitionProblem(undecided)).toBeNull();
    expect(
      tableFieldDefinitionProblem({ ...relation, type: 'text', referenceKind: 'doc' })
    ).toContain('Only relation fields can link to Snaglet items');
    expect(
      tableFieldDefinitionProblem({ ...relation, multiple: false, nullable: false })
    ).toContain('empty');
  });
});

describe('tableEntryValueProblem for Snaglet item relations', () => {
  const field: TableField = {
    ...relation,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'brief',
    type: 'relation',
    referenceKind: 'doc',
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    multiple: false,
    range: false,
    options: null,
  };
  const list: TableField = { ...field, multiple: true, nullable: false, defaultValue: [] };

  it('takes one item id, or null', () => {
    expect(tableEntryValueProblem(field, DOC_A)).toBeNull();
    expect(tableEntryValueProblem(field, 'test-agent-a')).toBeNull();
    expect(tableEntryValueProblem(field, null)).toBeNull();
    expect(tableEntryValueProblem(field, 'not an id')).toBe('Choose a doc to link.');
    expect(tableEntryValueProblem(field, [DOC_A])).toBe('Choose a doc to link.');
    expect(tableEntryValueProblem({ ...field, referenceKind: 'agent' }, 7)).toBe(
      'Choose an agent to link.'
    );
  });

  it('takes an ordered list of unique, case-sensitive ids, at most 100', () => {
    expect(tableEntryValueProblem(list, [DOC_B, DOC_A])).toBeNull();
    expect(tableEntryValueProblem(list, [])).toBeNull();
    expect(tableEntryValueProblem(list, null)).toBeNull();
    expect(tableEntryValueProblem(list, ['a', 'A'])).toBeNull();
    expect(tableEntryValueProblem(list, [DOC_A, DOC_A])).toContain('only once');
    expect(tableEntryValueProblem(list, DOC_A)).toBe('Choose docs to link.');
    expect(tableEntryValueProblem(list, [DOC_A, ''])).toBe('Choose docs to link.');
    expect(
      tableEntryValueProblem(
        list,
        Array.from({ length: 101 }, (_, n) => `doc-${n}`)
      )
    ).toBe('Link at most 100 docs.');
  });
});

describe('Snaglet item chips and ids in text', () => {
  it('reads chips and bare ids in order, separated by commas or spaces', () => {
    expect(tableReferenceIdsInText(`[Launch brief](${DOC_A})`)).toEqual([DOC_A]);
    expect(tableReferenceIdsInText(` ${DOC_A},  [Budget \\[draft\\]](${DOC_B}) `)).toEqual([
      DOC_A,
      DOC_B,
    ]);
    expect(tableReferenceIdsInText('[Test Agent A](test-agent-a)')).toEqual(['test-agent-a']);
    expect(tableReferenceIdsInText('[Test Project](project:container-1)')).toEqual(['container-1']);
    expect(tableReferenceIdsInText('')).toEqual([]);
    expect(tableReferenceIdsInText(' , ')).toEqual([]);
  });

  it('refuses text that is not only chips and ids', () => {
    expect(tableReferenceIdsInText('see [the brief')).toBeNull();
    expect(tableReferenceIdsInText('[Link](https://example.com/x y)')).toBeNull();
    expect(tableReferenceIdsInText('50%')).toBeNull();
  });

  it('unwraps a value that is exactly one chip and leaves the rest', () => {
    expect(unwrapTableReferenceChip(`[Launch brief](${DOC_A})`)).toBe(DOC_A);
    expect(unwrapTableReferenceChip(DOC_A)).toBe(DOC_A);
    expect(unwrapTableReferenceChip('Launch brief')).toBe('Launch brief');
    expect(unwrapTableReferenceChip(`[A](${DOC_A}) [B](${DOC_B})`)).toBe(
      `[A](${DOC_A}) [B](${DOC_B})`
    );
  });

  it('writes chips with escaped titles that read back', () => {
    const chip = tableReferenceChip(DOC_A, '[Draft] notes\\2\nnext');
    expect(chip).toBe(`[\\[Draft\\] notes\\\\2 next](${DOC_A})`);
    expect(tableReferenceIdsInText(chip)).toEqual([DOC_A]);
    expect(tableReferenceKindArticle('image')).toBe('an image');
  });
});
