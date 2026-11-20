import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import advancedSearch from '@server/services/ToolService/handlers/integrations/google/schemas/google-docs-advanced-search';
import append from '@server/services/ToolService/handlers/integrations/google/schemas/google-docs-append';
import create from '@server/services/ToolService/handlers/integrations/google/schemas/google-docs-create';
import list from '@server/services/ToolService/handlers/integrations/google/schemas/google-docs-list';
import read from '@server/services/ToolService/handlers/integrations/google/schemas/google-docs-read';

const operations = [
  { operation: 'advanced_search', definition: advancedSearch },
  { operation: 'append', definition: append },
  { operation: 'create', definition: create },
  { operation: 'list', definition: list },
  { operation: 'read', definition: read },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_docs',
  name: 'Google Docs',
  description: `Find, read, create and append plain text to Google Docs (not Snaglet docs: use doc). ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'docs', 'document', 'append', 'create', 'read', 'search'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
