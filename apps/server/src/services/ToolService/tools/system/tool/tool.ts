import { createCanonicalRouter } from '@server/services/ToolService/handlers/_shared/canonicalRouter';
import search from '@server/services/ToolService/handlers/tools/tool-search';
import schema from '@server/services/ToolService/handlers/tools/tool-schema';

export default createCanonicalRouter(
  {
    search: { handler: search, fields: ['query', 'mode', 'explain'] },
    schema: { handler: schema, fields: ['name', 'tool'], required: [['name', 'tool']] },
  },
  'tool'
);
