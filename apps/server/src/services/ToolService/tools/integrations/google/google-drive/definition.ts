import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import advancedSearch from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-advanced-search';
import downloadFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-download-file';
import getFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-get-file';
import listFiles from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-list-files';
import listPermissions from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-list-permissions';
import searchFiles from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-search-files';

const operations = [
  { operation: 'advanced_search', definition: advancedSearch },
  { operation: 'download_file', definition: downloadFile },
  { operation: 'get_file', definition: getFile },
  { operation: 'list_files', definition: listFiles },
  { operation: 'list_permissions', definition: listPermissions },
  { operation: 'search_files', definition: searchFiles },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_drive',
  name: 'Google Drive',
  description: `Read and download Google Drive files with a flat operation union. Use google_drive_admin for mutations and permission changes. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'file', 'folder', 'download', 'permission', 'search'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
