import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { LogsService } from '@server/services/LogsService';
import type { BuildModelCandidatesInput } from '@server/services/SocketService/handlers/modelCandidates';
import { getErrorMessage } from '@snaglet/shared/utils';

/**
 * Builds the `resolveCredentialIdForModel` callback passed into
 * buildModelCandidates. Extracted verbatim from runAgentTurn's pre-loop
 * setup — pure factory, no control flow, behavior-identical.
 *
 * Resolves a thread-override credential for a given provider/model, falling
 * back to the preferred credential (or null) and logging a warning if
 * resolution throws. threadId/agentId are captured only for log context.
 */
export function makeCredentialResolver({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}): BuildModelCandidatesInput['resolveCredentialIdForModel'] {
  return async ({ providerId, modelId, preferredCredentialId }) =>
    providerCredentialService
      .resolveCredentialIdForModel({
        providerId,
        modelId,
        preferredCredentialId,
      })
      .catch((err) => {
        LogsService.warn('thread override credential resolution failed', {
          threadId,
          agentId,
          providerId,
          modelId,
          preferredCredentialId: preferredCredentialId ?? null,
          error: getErrorMessage(err),
        });
        return preferredCredentialId ?? null;
      });
}
