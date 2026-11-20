import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import deleteMessage from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-delete';
import draftCreate from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-draft-create';
import forward from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-forward';
import getMessage from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-get-message';
import labels from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-labels';
import list from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-list';
import modifyLabels from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-modify-labels';
import reply from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-reply';
import search from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-search';
import send from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-send';
import trash from '@server/services/ToolService/handlers/integrations/google/schemas/google-gmail-trash';

const operations = [
  { operation: 'delete', definition: deleteMessage },
  { operation: 'draft_create', definition: draftCreate },
  { operation: 'forward', definition: forward },
  { operation: 'get_message', definition: getMessage },
  { operation: 'list_labels', definition: labels },
  { operation: 'list', definition: list },
  { operation: 'modify_labels', definition: modifyLabels },
  { operation: 'reply', definition: reply },
  { operation: 'search', definition: search },
  { operation: 'send', definition: send },
  { operation: 'trash', definition: trash },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_gmail',
  name: 'Google Gmail',
  description: `Gmail capability with a flat operation union. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  destructive: true,
  keywords: ['google', 'gmail', 'email', 'message', 'draft', 'label', 'send', 'search'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
