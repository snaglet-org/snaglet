/**
 * External image passthrough: a curated tool that attaches current-turn
 * pixels through `rawContent.ephemeralInlineImages` hands the MCP client a real
 * image content block after the text; malformed shapes never leak as blocks.
 * The tool here is a stand-in: any curated tool takes the same path.
 */

const getDefinitionMock = jest.fn();
const executeMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

jest.mock('@snaglet/db', () => ({
  Containers: {},
  Projects: {},
}));

const runWithActorMock = jest.fn((_actor: unknown, operation: () => unknown) => operation());
jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (actor: unknown, operation: () => unknown) => runWithActorMock(actor, operation),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';

const PNG_BASE64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const CALLER = { memberId: 'member-1', name: 'External test' };

beforeEach(() => {
  jest.clearAllMocks();
  getDefinitionMock.mockImplementation((id: string) =>
    id === 'search'
      ? {
          id,
          name: id,
          description: id,
          type: 'builtin',
          tier: 'standard',
          categoryPath: 'media',
          parameters_schema: {},
          keywords: [],
        }
      : undefined
  );
});

describe('McpGatewayService image passthrough', () => {
  it('appends an image/png block for an attached image and runs as the external actor', async () => {
    executeMock.mockResolvedValue({
      success: true,
      output: 'Found the image inline',
      rawContent: {
        success: true,
        ephemeralInlineImages: [
          {
            id: 'image-1111111111111-aaaaaaaaa',
            mediaType: 'image/png',
            data: PNG_BASE64,
          },
        ],
      },
      durationMs: 1,
    });

    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_search',
      { query: 'a cat' },
      CALLER
    );

    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Found the image inline' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      ],
    });
    expect(runWithActorMock).toHaveBeenCalledWith(
      { actorId: 'member-1', actorKind: 'external', actorName: 'External test' },
      expect.any(Function)
    );
    expect(executeMock).toHaveBeenCalledWith(
      { name: 'search', input: { query: 'a cat' } },
      expect.objectContaining({ tool: expect.objectContaining({ id: 'search' }) }),
      {}
    );
  });

  it('stays text-only when no conforming image is attached', async () => {
    executeMock.mockResolvedValue({
      success: true,
      output: '{"success":true}',
      rawContent: {
        ephemeralInlineImages: [
          { id: 'x', mediaType: 'image/svg+xml', data: '<svg/>' },
          { data: '' },
        ],
      },
      durationMs: 1,
    });

    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_search',
      { query: 'a cat' },
      CALLER
    );

    expect(result).toEqual({ content: [{ type: 'text', text: '{"success":true}' }] });
  });
});
