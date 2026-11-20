/**
 * After a verified Claude Code sign-in, everything that was pinned to a dead
 * Claude Code credential moves to the fresh login.
 *
 * Sign-in only ever writes the managed row. When the credential that actually
 * died was a different one — a token pasted by hand, which Snaglet cannot refresh —
 * agents, summary models and the provider primary stayed pinned to it and kept
 * failing. A credential counts as dead when its last check or call failed
 * authentication (`verification_status = 'fail'`) or Anthropic rejected its
 * token in this process. The dead row itself is kept, never overwritten: its
 * `fail` verdict may come from a verify that hit an outage, and the user can
 * delete it once nothing points at it.
 *
 * Only Claude Code OAuth rows are candidates. API-key rows are never moved
 * onto a subscription login, even when they failed.
 */

import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import type { UserProviderCredentialRow } from '@snaglet/db/tables/user_provider_credentials';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import {
  repointCredentialPins,
  type CredentialPinChanges,
} from '@server/services/ProviderCredentialService/credentialPins';
import { isAnthropicOAuthToken } from '@server/services/ProviderChatService/shared';
import { isRejectedToken } from './rejectedTokens';
import { CLAUDE_CODE_AUTH_TYPE_ID, CLAUDE_CODE_PROVIDER_ID } from './sync';

function isClaudeCodeRow(row: UserProviderCredentialRow): boolean {
  return (
    row.providerId === CLAUDE_CODE_PROVIDER_ID &&
    (row.authTypeId === CLAUDE_CODE_AUTH_TYPE_ID || row.authType === 'oauth')
  );
}

async function isDead(row: UserProviderCredentialRow): Promise<boolean> {
  if (row.verificationStatus === 'fail') return true;
  try {
    const secret = await providerCredentialService.getSecretById(row.id);
    return !!secret && isAnthropicOAuthToken(secret) && isRejectedToken(secret);
  } catch (err) {
    logger.warn(`[claude-code-auth] could not read credential ${row.id}: ${getErrorMessage(err)}`);
    return false;
  }
}

/** Claude Code credentials, other than `managedCredentialId`, that failed auth. */
export async function findDeadClaudeCodeCredentialIds(
  managedCredentialId: string
): Promise<string[]> {
  const rows = (await UserProviderCredentials.listAll()).filter(
    (row) => row.id !== managedCredentialId && isClaudeCodeRow(row)
  );
  const dead: string[] = [];
  for (const row of rows) {
    if (await isDead(row)) dead.push(row.id);
  }
  return dead;
}

/**
 * Move the provider primary and every pin on a dead Claude Code credential to
 * the freshly verified managed row; an empty Anthropic primary is filled too.
 */
export async function adoptPinsForClaudeCodeSignIn(
  managedCredentialId: string
): Promise<CredentialPinChanges> {
  const dead = await findDeadClaudeCodeCredentialIds(managedCredentialId);
  const changes = await repointCredentialPins({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    fromCredentialIds: dead,
    toCredentialId: managedCredentialId,
    fillEmptyPrimary: true,
    context: 'Claude Code sign-in',
  });
  if (dead.length > 0) {
    logger.info(
      `[claude-code-auth] sign-in replaced failed credential(s) ${dead.join(', ')} ` +
        `with ${managedCredentialId}`
    );
  }
  return changes;
}
