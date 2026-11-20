import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import advancedSearch from '@server/services/ToolService/handlers/integrations/google/drive/advancedSearch';
import downloadFile from '@server/services/ToolService/handlers/integrations/google/drive/downloadFile';
import getFile from '@server/services/ToolService/handlers/integrations/google/drive/getFile';
import listFiles from '@server/services/ToolService/handlers/integrations/google/drive/listFiles';
import listPermissions from '@server/services/ToolService/handlers/integrations/google/drive/listPermissions';
import searchFiles from '@server/services/ToolService/handlers/integrations/google/drive/searchFiles';

export default createCapabilityRouter({
  advanced_search: advancedSearch,
  download_file: downloadFile,
  get_file: getFile,
  list_files: listFiles,
  list_permissions: listPermissions,
  search_files: searchFiles,
});
