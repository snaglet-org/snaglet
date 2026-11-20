/**
 * Claude Code OAuth for the Anthropic provider: keychain sync, interactive
 * sign-in sessions, and revoked-token recovery share this one service.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  describePinChanges,
  hasPinChanges,
} from '@server/services/ProviderCredentialService/credentialPins';
import { ClaudeCodeLoginService } from './loginSession';
import { forgetClaudeCliAuthCache } from '@server/services/ProviderChatService/providers/claudeCliAuth';
import { adoptPinsForClaudeCodeSignIn } from './signInPins';
import {
  readUsableClaudeCliAuth,
  syncClaudeCodeCredential,
  type ClaudeCodeSyncResult,
} from './sync';

export { syncClaudeCodeCredential } from './sync';

/**
 * A verified sign-in takes over whatever a dead Claude Code credential was
 * pinned to. A failure here never fails the sign-in itself.
 */
async function signInMessage(result: ClaudeCodeSyncResult): Promise<string> {
  try {
    const changes = await adoptPinsForClaudeCodeSignIn(result.credential.id);
    return hasPinChanges(changes)
      ? `${result.message} ${describePinChanges(changes)}`
      : result.message;
  } catch (err) {
    logger.warn(
      `[claude-code-auth] signed in, but could not move pins to ${result.credential.id}: ` +
        getErrorMessage(err)
    );
    return result.message;
  }
}

export const claudeCodeLoginService = new ClaudeCodeLoginService({
  // A usable keychain login that verifies connects without a browser; one
  // that is missing, expired or rejected falls through to `claude auth login`.
  preflight: async () => {
    const auth = await readUsableClaudeCliAuth(true);
    if (!auth) return null;
    const result = await syncClaudeCodeCredential({ verify: true, auth });
    return result.verification === 'ok'
      ? { ok: true, message: await signInMessage(result), credentialId: result.credential.id }
      : null;
  },
  complete: async () => {
    forgetClaudeCliAuthCache();
    const result = await syncClaudeCodeCredential({ verify: true });
    const ok = result.verification === 'ok';
    return {
      ok,
      message: ok ? await signInMessage(result) : result.message,
      credentialId: result.credential.id,
    };
  },
});
