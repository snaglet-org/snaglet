import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import advancedSearch from '@server/services/ToolService/handlers/integrations/google/docs/advancedSearch';
import append from '@server/services/ToolService/handlers/integrations/google/docs/append';
import create from '@server/services/ToolService/handlers/integrations/google/docs/create';
import list from '@server/services/ToolService/handlers/integrations/google/docs/list';
import read from '@server/services/ToolService/handlers/integrations/google/docs/read';

export default createCapabilityRouter({
  advanced_search: advancedSearch,
  append,
  create,
  list,
  read,
});
