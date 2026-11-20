import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import check from '@server/services/ToolService/handlers/integrations/imessage/schemas/check-imessage';
import listConversations from '@server/services/ToolService/handlers/integrations/imessage/schemas/list-imessage-conversations';
import read from '@server/services/ToolService/handlers/integrations/imessage/schemas/read-imessage';
import search from '@server/services/ToolService/handlers/integrations/imessage/schemas/search-imessage';
import send from '@server/services/ToolService/handlers/integrations/imessage/schemas/send-imessage';

const operations = [
  { operation: 'check', definition: check },
  { operation: 'list_conversations', definition: listConversations },
  { operation: 'read', definition: read },
  { operation: 'search', definition: search },
  { operation: 'send', definition: send },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'imessage',
  name: 'iMessage',
  description: `Read, search, and send messages through macOS Messages with a flat operation union. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  tier: 'standard',
  destructive: true,
  keywords: ['apple', 'imessage', 'sms', 'message', 'conversation', 'read', 'search', 'send'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
