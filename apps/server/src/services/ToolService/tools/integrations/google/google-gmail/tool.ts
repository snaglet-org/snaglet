import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import deleteMessage from '@server/services/ToolService/handlers/integrations/google/gmail/delete';
import draftCreate from '@server/services/ToolService/handlers/integrations/google/gmail/draftCreate';
import forward from '@server/services/ToolService/handlers/integrations/google/gmail/forward';
import getMessage from '@server/services/ToolService/handlers/integrations/google/gmail/getMessage';
import labels from '@server/services/ToolService/handlers/integrations/google/gmail/labels';
import list from '@server/services/ToolService/handlers/integrations/google/gmail/list';
import modifyLabels from '@server/services/ToolService/handlers/integrations/google/gmail/modifyLabels';
import reply from '@server/services/ToolService/handlers/integrations/google/gmail/reply';
import search from '@server/services/ToolService/handlers/integrations/google/gmail/search';
import send from '@server/services/ToolService/handlers/integrations/google/gmail/send';
import trash from '@server/services/ToolService/handlers/integrations/google/gmail/trash';

export default createCapabilityRouter({
  delete: deleteMessage,
  draft_create: draftCreate,
  forward,
  get_message: getMessage,
  list_labels: labels,
  list,
  modify_labels: modifyLabels,
  reply,
  search,
  send,
  trash,
});
