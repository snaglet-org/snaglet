/**
 * Keeps Anthropic requests on the token Claude Code is currently using.
 *
 * The stored `anthropic:claude-code-pro` secret is only a snapshot; Claude
 * Code rotates its keychain token whenever it refreshes. Before a request,
 * `resolveClaudeCodeSecret` swaps in the live keychain token when it differs
 * (and mirrors it back to the store). After a 401, `recoverClaudeCodeToken`
 * re-reads once: a rotated token means retry once; the same token means the
 * login is revoked, so the credential is marked failed and that token is
 * remembered as bad until the keychain produces a different one — no retry
 * storms from every agent run hitting the same dead credential.
 *
 * Only the credential Snaglet mirrored from Claude Code is refreshed. Any other
 * OAuth token (one pasted for a different account, say) is used as stored; a
 * 401 on it only marks that row failed.
 */

import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  isClaudeCliAuthCurrent,
  readClaudeCliAuthCached,
  tokenFingerprint,
} from '@server/services/ProviderChatService/providers/claudeCliAuth';
import { isAnthropicOAuthToken } from '@server/services/ProviderChatService/shared';
import {
  isClaudeCodeManagedSecret,
  markClaudeCodeCredentialFailed,
  markCredentialAuthFailed,
  syncClaudeCodeCredential,
} from './sync';
import { forgetAllRejectedTokens, isRejectedToken, rememberRejectedToken } from './rejectedTokens';

export const CLAUDE_CODE_REAUTH_MESSAGE =
  'Claude Code login has expired or been revoked. Open Providers → Anthropic and use ' +
  '“Sign in with Claude Code” to reconnect.';

/** One recovery per rejected token: runs failing on the same token share it. */
const recovering = new Map<string, Promise<string | null>>();

export function isClaudeCodeTokenKnownBad(token: string): boolean {
  return isRejectedToken(token);
}

/** Test hook. */
export function resetClaudeCodeRecoveryState(): void {
  forgetAllRejectedTokens();
  recovering.clear();
}

/**
 * Anthropic rejected `token` even after recovery handed it out: remember it
 * and mark the credential failed so later runs stop before calling out.
 */
export async function markClaudeCodeTokenRejected(token: string): Promise<void> {
  rememberRejectedToken(token);
  const credentialId = await markClaudeCodeCredentialFailed(token).catch(() => null);
  logger.warn(
    `[claude-code-auth] recovered token ${tokenFingerprint(token)} was rejected too` +
      `${credentialId ? ` — credential ${credentialId} marked failed` : ''}`
  );
}

/**
 * The token to send: the live keychain token when it is newer than the stored
 * snapshot, otherwise the snapshot. Ordinary API keys pass straight through.
 */
export async function resolveClaudeCodeSecret(
  storedSecret: string,
  credentialId: string | null = null
): Promise<string> {
  if (!isAnthropicOAuthToken(storedSecret)) return storedSecret;
  if (!(await isClaudeCodeManagedSecret(storedSecret, credentialId))) return storedSecret;
  const live = await readClaudeCliAuthCached();
  if (!live || !isClaudeCliAuthCurrent(live) || live.accessToken === storedSecret) {
    return storedSecret;
  }
  logger.info(
    `[claude-code-auth] keychain token rotated (${tokenFingerprint(storedSecret)} → ` +
      `${tokenFingerprint(live.accessToken)}); using the live token`
  );
  // Mirror it so credential routing and the Providers page catch up. Not
  // awaited: the request must not wait on a DB write.
  syncClaudeCodeCredential({ verify: false, auth: live }).catch((err: unknown) => {
    logger.warn(`[claude-code-auth] could not mirror rotated token: ${getErrorMessage(err)}`);
  });
  return live.accessToken;
}

/**
 * After Anthropic rejected `usedToken`: return a different, current keychain
 * token to retry with once, or null when the login needs re-authentication
 * (in which case the credential has been marked failed).
 */
export async function recoverClaudeCodeToken(
  usedToken: string,
  credentialId: string | null = null
): Promise<string | null> {
  if (!isAnthropicOAuthToken(usedToken)) return null;
  const used = tokenFingerprint(usedToken);
  if (!isRejectedToken(usedToken) && !(await isClaudeCodeManagedSecret(usedToken, credentialId))) {
    // A token pasted by hand: Snaglet cannot refresh it, but it records the
    // rejection so the Providers page shows it and the next Claude Code
    // sign-in moves this row's pins to the fresh login.
    if (credentialId) {
      const marked = await markCredentialAuthFailed(credentialId, usedToken).catch(
        (err: unknown) => {
          logger.warn(
            `[claude-code-auth] could not mark credential ${credentialId} failed: ` +
              getErrorMessage(err)
          );
          return false;
        }
      );
      if (marked) {
        logger.warn(
          `[claude-code-auth] token ${used} on unmanaged credential ${credentialId} was ` +
            'rejected — marked failed; sign in with Claude Code to replace it'
        );
      }
    }
    return null;
  }
  const inFlight = recovering.get(used);
  if (inFlight) return inFlight;
  const attempt = (async () => {
    try {
      const live = await readClaudeCliAuthCached(true);
      if (live && isClaudeCliAuthCurrent(live) && live.accessToken !== usedToken) {
        if (isRejectedToken(live.accessToken)) return null;
        forgetAllRejectedTokens();
        logger.info(
          `[claude-code-auth] recovered from a rejected token via the keychain ` +
            `(${used} → ${tokenFingerprint(live.accessToken)})`
        );
        await syncClaudeCodeCredential({ verify: false, auth: live }).catch((err: unknown) => {
          logger.warn(
            `[claude-code-auth] could not mirror recovered token: ${getErrorMessage(err)}`
          );
        });
        return live.accessToken;
      }
      rememberRejectedToken(usedToken);
      const failedId = await markClaudeCodeCredentialFailed(usedToken).catch(() => null);
      logger.warn(
        `[claude-code-auth] token ${used} rejected and the keychain holds no newer login` +
          `${failedId ? ` — credential ${failedId} marked failed` : ''}`
      );
      return null;
    } finally {
      recovering.delete(used);
    }
  })();
  recovering.set(used, attempt);
  return attempt;
}
