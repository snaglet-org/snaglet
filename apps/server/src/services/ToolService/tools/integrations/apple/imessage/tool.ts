import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import check from '@server/services/ToolService/handlers/integrations/imessage/checkAvailability';
import listConversations from '@server/services/ToolService/handlers/integrations/imessage/listConversations';
import read from '@server/services/ToolService/handlers/integrations/imessage/readConversation';
import search from '@server/services/ToolService/handlers/integrations/imessage/searchMessages';
import send from '@server/services/ToolService/handlers/integrations/imessage/sendMessage';

export default createCapabilityRouter({
  check,
  list_conversations: listConversations,
  read,
  search,
  send,
});
