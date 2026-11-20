import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import copyFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-copy-file';
import createFolder from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-create-folder';
import deleteFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-delete-file';
import moveFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-move-file';
import renameFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-rename-file';
import revokePermission from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-revoke-permission';
import shareFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-share-file';
import uploadFile from '@server/services/ToolService/handlers/integrations/google/schemas/google-drive-upload-file';

const operations = [
  { operation: 'copy_file', definition: copyFile },
  { operation: 'create_folder', definition: createFolder },
  { operation: 'delete_file', definition: deleteFile },
  { operation: 'move_file', definition: moveFile },
  { operation: 'rename_file', definition: renameFile },
  { operation: 'revoke_permission', definition: revokePermission },
  { operation: 'share_file', definition: shareFile },
  { operation: 'upload_file', definition: uploadFile },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_drive_admin',
  name: 'Google Drive Admin',
  description: `Create, mutate, upload, share, and delete Google Drive files with a flat operation union. Use google_drive for read-only lookup and downloads. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  destructive: true,
  keywords: [
    'google',
    'drive',
    'file',
    'folder',
    'copy',
    'delete',
    'move',
    'rename',
    'share',
    'upload',
  ],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
