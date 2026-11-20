import { createCanonicalRouter } from '@server/services/ToolService/handlers/_shared/canonicalRouter';
import create from '@server/services/ToolService/handlers/tools/custom-tool-create';
import update from '@server/services/ToolService/handlers/tools/custom-tool-update';

export default createCanonicalRouter(
  {
    create: {
      handler: create,
      fields: ['name', 'description', 'parameters_schema', 'handler_source', 'overwrite'],
      required: ['name', 'description'],
    },
    update: {
      handler: update,
      fields: ['name', 'description', 'parameters_schema', 'handler_source'],
      required: ['name'],
    },
  },
  'custom_tool'
);
