import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const search = jest.fn(async () => 'searched');
const schema = jest.fn(async () => 'schema');
const create = jest.fn(async () => 'created');
const update = jest.fn(async () => 'updated');
jest.mock('@server/services/ToolService/handlers/tools/tool-search', () => ({
  __esModule: true,
  default: search,
}));
jest.mock('@server/services/ToolService/handlers/tools/tool-schema', () => ({
  __esModule: true,
  default: schema,
}));
jest.mock('@server/services/ToolService/handlers/tools/custom-tool-create', () => ({
  __esModule: true,
  default: create,
}));
jest.mock('@server/services/ToolService/handlers/tools/custom-tool-update', () => ({
  __esModule: true,
  default: update,
}));

import toolTool from '@server/services/ToolService/tools/system/tool/tool';
import customTool from '@server/services/ToolService/tools/system/custom-tool/tool';
import { resolveToolId } from '@snaglet/shared/utils/toolAliases';

beforeEach(() => jest.clearAllMocks());

describe('tool(op) dispatcher', () => {
  it('routes search and schema, forwarding op-stripped input', async () => {
    await toolTool({ op: 'search', query: 'doc', mode: 'keyword' }, {}, undefined);
    await toolTool({ op: 'schema', name: 'doc' }, {}, undefined);
    expect(search).toHaveBeenCalledWith({ query: 'doc', mode: 'keyword' }, {}, undefined);
    expect(schema).toHaveBeenCalledWith({ name: 'doc' }, {}, undefined);
  });

  it('search needs no query (list mode) but rejects cross-op fields', async () => {
    await toolTool({ op: 'search', mode: 'list' }, {}, undefined);
    expect(search).toHaveBeenCalledTimes(1);
    await expect(toolTool({ op: 'search', name: 'doc' }, {}, undefined)).rejects.toThrow('name');
  });

  it('schema requires name (or the retired tool spelling)', async () => {
    await expect(toolTool({ op: 'schema' }, {}, undefined)).rejects.toThrow('name');
    await toolTool({ op: 'schema', tool: 'doc' }, {}, undefined);
    expect(schema).toHaveBeenCalledTimes(1);
  });

  it('legacy ids route through the pinned alias to the same handlers', async () => {
    const oldSchema = resolveToolId('get_tool_schema').transformParams?.({ tool: 'doc' });
    await toolTool(oldSchema as Record<string, unknown>, {}, undefined);
    expect(schema).toHaveBeenCalledTimes(1);
    const oldSearch = resolveToolId('search_tools').transformParams?.({ query: 'x', op: 'schema' });
    await toolTool(oldSearch as Record<string, unknown>, {}, undefined);
    expect(search).toHaveBeenCalledTimes(1);
    const list = resolveToolId('list_tools').transformParams?.({});
    await toolTool(list as Record<string, unknown>, {}, undefined);
    expect(search).toHaveBeenLastCalledWith({ mode: 'list' }, {}, undefined);
  });
});

describe('custom_tool(op) dispatcher', () => {
  it('routes create and update', async () => {
    await customTool({ op: 'create', name: 'a-tool', description: 'd' }, {}, undefined);
    await customTool({ op: 'update', name: 'a-tool', handler_source: 'src' }, {}, undefined);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('validates required fields per op', async () => {
    await expect(customTool({ op: 'create', name: 'a-tool' }, {}, undefined)).rejects.toThrow(
      'description'
    );
    await expect(customTool({ op: 'update' }, {}, undefined)).rejects.toThrow('name');
    await expect(
      customTool({ op: 'update', name: 'a-tool', overwrite: true }, {}, undefined)
    ).rejects.toThrow('overwrite');
  });

  it('create_tool still accepts the legacy overwrite flag, pinned to create', async () => {
    const old = resolveToolId('create_tool').transformParams?.({
      name: 'a-tool',
      description: 'd',
      overwrite: true,
      op: 'update',
    });
    await customTool(old as Record<string, unknown>, {}, undefined);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
