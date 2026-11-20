import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, UpdateTableFieldRequest } from '@snaglet/shared/types';
import { createSelectOption } from './createSelectOption';

const api = vi.hoisted(() => ({ fields: vi.fn(), updateField: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'status',
  name: 'status',
  type: 'select',
  nullable: true,
  description: null,
  defaultValue: 'Open',
  referenceTableId: null,
  referenceKind: null,
  multiple: false,
  managed: false,
  isTitle: false,
  collapsed: false,
  position: 0,
  revision: 2,
  options: [{ id: 'opt-open', label: 'Open', color: 'blue' }],
};
beforeEach(() => {
  vi.resetAllMocks();
  api.fields.mockResolvedValue({ fields: [field] });
  api.updateField.mockImplementation(
    (_table: string, _field: string, req: UpdateTableFieldRequest) => ({
      field: {
        ...field,
        revision: 3,
        options: req.options?.map((option) => ({ ...option, color: option.color ?? 'green' })),
      },
    })
  );
});

describe('create select option from a cell', () => {
  it('preserves current settings and stable options, using the current field revision', async () => {
    const result = await createSelectOption(field.tableId, field.id, '  Done  ');
    expect(api.updateField).toHaveBeenCalledWith(field.tableId, field.id, {
      name: 'status',
      description: null,
      type: 'select',
      nullable: true,
      defaultValue: 'Open',
      referenceTableId: null,
      multiple: false,
      expectedRevision: 2,
      options: [field.options?.[0], { id: expect.stringMatching(/^opt-/), label: 'Done' }],
    });
    expect(result.option).toMatchObject({ label: 'Done', color: 'green' });
    expect(result.field.revision).toBe(3);
  });
  it('reuses canonical labels on an ambiguous retry or case-insensitive match', async () => {
    expect((await createSelectOption(field.tableId, field.id, 'open')).option.label).toBe('Open');
    expect(api.updateField).not.toHaveBeenCalled();
  });
  it.each(['', 'a\nb', 'x'.repeat(101)])(
    'rejects invalid label %j before making requests',
    async (label) => {
      await expect(createSelectOption(field.tableId, field.id, label)).rejects.toThrow();
      expect(api.fields).not.toHaveBeenCalled();
    }
  );
  it('refuses a field converted elsewhere', async () => {
    api.fields.mockResolvedValue({ fields: [{ ...field, type: 'text', options: null }] });
    await expect(createSelectOption(field.tableId, field.id, 'Done')).rejects.toThrow('no longer');
    expect(api.updateField).not.toHaveBeenCalled();
  });
  it('keeps a stale revision failure intact instead of silently overwriting settings', async () => {
    const error = new Error('Changed elsewhere');
    api.updateField.mockRejectedValue(error);
    await expect(createSelectOption(field.tableId, field.id, 'Done')).rejects.toBe(error);
    expect(api.updateField).toHaveBeenCalledTimes(1);
  });
  it('caps additions but still permits reuse at the limit', async () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      id: `opt-${index}`,
      label: `Option ${index}`,
      color: 'blue',
    }));
    api.fields.mockResolvedValue({ fields: [{ ...field, options }] });
    await expect(createSelectOption(field.tableId, field.id, 'New')).rejects.toThrow('at most 100');
    expect((await createSelectOption(field.tableId, field.id, 'option 0')).option.label).toBe(
      'Option 0'
    );
    expect(api.updateField).not.toHaveBeenCalled();
  });
});
