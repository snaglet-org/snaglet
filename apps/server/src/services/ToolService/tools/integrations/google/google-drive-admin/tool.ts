import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import copyFile from '@server/services/ToolService/handlers/integrations/google/drive/copyFile';
import createFolder from '@server/services/ToolService/handlers/integrations/google/drive/createFolder';
import deleteFile from '@server/services/ToolService/handlers/integrations/google/drive/deleteFile';
import moveFile from '@server/services/ToolService/handlers/integrations/google/drive/moveFile';
import renameFile from '@server/services/ToolService/handlers/integrations/google/drive/renameFile';
import revokePermission from '@server/services/ToolService/handlers/integrations/google/drive/revokePermission';
import shareFile from '@server/services/ToolService/handlers/integrations/google/drive/shareFile';
import uploadFile from '@server/services/ToolService/handlers/integrations/google/drive/uploadFile';

export default createCapabilityRouter({
  copy_file: copyFile,
  create_folder: createFolder,
  delete_file: deleteFile,
  move_file: moveFile,
  rename_file: renameFile,
  revoke_permission: revokePermission,
  share_file: shareFile,
  upload_file: uploadFile,
});
