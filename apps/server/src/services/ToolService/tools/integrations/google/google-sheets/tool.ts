import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import append from '@server/services/ToolService/handlers/integrations/google/sheets/append';
import create from '@server/services/ToolService/handlers/integrations/google/sheets/create';
import read from '@server/services/ToolService/handlers/integrations/google/sheets/read';

export default createCapabilityRouter({
  append,
  create,
  read,
});
