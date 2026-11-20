import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import branch from '@server/services/ToolService/handlers/integrations/git/branch';
import checkout from '@server/services/ToolService/handlers/integrations/git/checkout';
import commit from '@server/services/ToolService/handlers/integrations/git/commit';
import diff from '@server/services/ToolService/handlers/integrations/git/diff';
import log from '@server/services/ToolService/handlers/integrations/git/log';
import pull from '@server/services/ToolService/handlers/integrations/git/pull';
import push from '@server/services/ToolService/handlers/integrations/git/push';
import stash from '@server/services/ToolService/handlers/integrations/git/stash';
import status from '@server/services/ToolService/handlers/integrations/git/status';
import verify from '@server/services/ToolService/handlers/integrations/git/verify';

export default createCapabilityRouter(
  {
    branch,
    checkout,
    commit,
    diff,
    log,
    pull,
    push,
    stash,
    status,
    verify,
  },
  'subcommand'
);
