import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'web_search',
  name: 'Search Web',
  description:
    'Search the internet. Use it for any fact outside the workspace that may be newer than your training: library and API docs, versions, error messages, prices, news. Returns up to `num` results (title, URL, snippet); snippets are leads, so read the page with `web_fetch` before relying on it. Runs on DuckDuckGo (no API key): a bot challenge, non-200 response, network failure or 15 s timeout fails with an error, never empty results. On failure, use a connected search MCP server such as Firecrawl.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['web', 'search', 'internet', 'google', 'query', 'results'],
  parameters_schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      num: {
        type: 'integer',
        default: 5,
        minimum: 1,
        maximum: 10,
        description: 'Number of results to return (1-10, default 5).',
      },
    },
  },
  sort_order: 71,
};

export default definition;
