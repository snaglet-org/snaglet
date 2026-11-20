import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import append from '@server/services/ToolService/handlers/integrations/google/schemas/google-sheets-append';
import create from '@server/services/ToolService/handlers/integrations/google/schemas/google-sheets-create';
import read from '@server/services/ToolService/handlers/integrations/google/schemas/google-sheets-read';

const operations = [
  { operation: 'append', definition: append },
  { operation: 'create', definition: create },
  { operation: 'read', definition: read },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_sheets',
  name: 'Google Sheets',
  description: `Google Sheets capability with a flat operation union. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'sheets', 'spreadsheet', 'append', 'create', 'read'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
