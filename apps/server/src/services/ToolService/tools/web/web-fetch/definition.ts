import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'web_fetch',
  name: 'Fetch URL',
  description: 'Make an HTTP request and return the response',
  type: 'builtin',
  tier: 'standard',
  keywords: ['fetch', 'url', 'http', 'request', 'get', 'api', 'download', 'web'],
  parameters_schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      body: {
        type: 'string',
        description: 'Request body',
      },
      method: {
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        type: 'string',
        default: 'GET',
        description: 'HTTP method',
      },
      headers: {
        type: 'object',
        description: 'Request headers',
      },
    },
  },
  sort_order: 50,
};

export default definition;
