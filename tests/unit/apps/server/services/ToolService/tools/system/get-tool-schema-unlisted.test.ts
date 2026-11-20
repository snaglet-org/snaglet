/**
 * get_tool_schema returns a tool's `unlisted_params` as
 * `unlisted_parameters`, read from the loaded definition (never the DB row,
 * so they can't leak into the wire schema). Tools without any keep the
 * response shape they had before.
 */
const findById = jest.fn();
const findByAlias = jest.fn();
const getDefinition = jest.fn();

jest.mock('@snaglet/db', () => ({
  Tools: {
    findById: (...a: unknown[]) => findById(...a),
    findByAlias: (...a: unknown[]) => findByAlias(...a),
  },
}));
jest.mock('@server/services/McpService', () => ({
  mcpService: { isMcpToolId: () => false },
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: { getDefinition: (...a: unknown[]) => getDefinition(...a) },
}));

import getToolSchema from '@server/services/ToolService/handlers/tools/tool-schema';
import searchDefinition from '@server/services/ToolService/tools/workspace/search/definition';

const row = (id: string, parametersSchema: Record<string, unknown>) => ({
  id,
  name: id,
  description: `${id} description`,
  categoryPath: 'uncategorized',
  providerId: null,
  tier: 'core',
  keywords: [],
  aliases: [],
  parametersSchema,
  enabled: true,
});

beforeEach(() => jest.clearAllMocks());

it('search: returns the advertised schema plus every unlisted field', async () => {
  findById.mockResolvedValue(row('search', searchDefinition.parameters_schema));
  getDefinition.mockReturnValue(searchDefinition);
  const out = JSON.parse(String(await getToolSchema({ tool: 'search' }, {})));
  expect(out.parameters_schema.properties).not.toHaveProperty('graph_depth');
  expect(out.unlisted_parameters).toEqual(searchDefinition.unlisted_params);
  expect(Object.keys(out.unlisted_parameters)).toEqual(
    expect.arrayContaining(['graph_depth', 'table', 'order_direction', 'archived_only'])
  );
  expect(getDefinition).toHaveBeenCalledWith('search');
});

it('a tool without unlisted params keeps its response shape plus the gateway hint', async () => {
  findById.mockResolvedValue(row('memory', { type: 'object', properties: {} }));
  getDefinition.mockReturnValue({ id: 'memory' });
  const out = JSON.parse(String(await getToolSchema({ tool: 'memory' }, {})));
  expect(out).not.toHaveProperty('unlisted_parameters');
  expect(Object.keys(out)).toEqual([
    'id',
    'name',
    'description',
    'category_path',
    'provider_id',
    'tier',
    'keywords',
    'aliases',
    'parameters_schema',
    'call_with',
  ]);
});

it('says how to call the fetched tool, since it is never added to the advertised set', async () => {
  findById.mockResolvedValue(row('memory', { type: 'object', properties: {} }));
  getDefinition.mockReturnValue({ id: 'memory' });
  const out = JSON.parse(String(await getToolSchema({ tool: 'memory' }, {})));
  expect(out.call_with).toBe('action({tool: "memory", params: {...}})');
});
