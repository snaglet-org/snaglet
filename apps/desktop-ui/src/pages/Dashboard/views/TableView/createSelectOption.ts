import {
  TABLE_SELECT_MAX_OPTIONS,
  type TableSelectOption,
  type TableField,
} from '@snaglet/shared/types';
import { generateId, selectOptionLabelProblem } from '@snaglet/shared/utils';
import { tablesApi } from '@desktop/utils/api';

/** Read first: a retry may find an option whose successful response was lost. */
export async function createSelectOption(
  tableId: string,
  fieldId: string,
  input: string
): Promise<{ field: TableField; option: TableSelectOption }> {
  const label = input.trim();
  const problem = selectOptionLabelProblem(label);
  if (problem) throw new Error(problem);
  const { fields } = await tablesApi.fields(tableId);
  const field = fields.find((item) => item.id === fieldId);
  if (!field || field.managed || field.type !== 'select')
    throw new Error('This field is no longer an editable Select field.');
  const existing = field.options?.find(
    (option) => option.label.toLowerCase() === label.toLowerCase()
  );
  if (existing) return { field, option: existing };
  if ((field.options?.length ?? 0) >= TABLE_SELECT_MAX_OPTIONS)
    throw new Error(`A select field can have at most ${TABLE_SELECT_MAX_OPTIONS} options.`);
  const optionId = generateId('opt');
  const result = await tablesApi.updateField(tableId, fieldId, {
    name: field.name,
    description: field.description,
    type: 'select',
    nullable: field.nullable,
    defaultValue: field.defaultValue,
    referenceTableId: null,
    multiple: field.multiple,
    expectedRevision: field.revision,
    options: [...(field.options ?? []), { id: optionId, label }],
  });
  const option = result.field.options?.find((item) => item.id === optionId);
  if (!option) throw new Error('The new option is unavailable. Reload the field and try again.');
  return { field: result.field, option };
}
