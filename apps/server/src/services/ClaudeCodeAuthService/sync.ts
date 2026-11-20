/**
 * Keychain → credential store synchronization for Claude Code OAuth.
 *
 * Claude Code refreshes and rotates its OAuth token in the macOS keychain on
 * its own schedule. Snaglet keeps an `anthropic:claude-code-pro` credential row so
 * the token participates in normal credential routing, but that row is only
 * ever a mirror of the keychain: `syncClaudeCodeCredential` re-reads the
 * keychain, upserts the row in place (never a second row), and optionally
 * verifies it live before marking it `ok`.
 */

import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { parseProviderCredentialInput } from '@server/services/ProviderCredentialService/format';
import type { SafeProviderCredential } from '@server/services/ProviderCredentialService/types';
import { providerChatService } from '@server/services/ProviderChatService';
import {
  isClaudeCliAuthCurrent,
  readClaudeCliAuthCached,
  tokenFingerprint,
  type ClaudeCliAuth,
} from '@server/services/ProviderChatService/providers/claudeCliAuth';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { logger } from '@server/config/logger';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { forgetRejectedToken } from './rejectedTokens';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

export const CLAUDE_CODE_PROVIDER_ID = 'anthropic';
export const CLAUDE_CODE_AUTH_TYPE_ID = 'anthropic:claude-code-pro';
const CLAUDE_CODE_CREDENTIAL_LABEL = 'Claude Code login';
/**
 * Provenance marker on the mirrored row. A user can also paste a Claude Code
 * token by hand under the same auth type; that row is theirs and is never
 * overwritten by keychain sync. Older imported rows carry only
 * LEGACY_IMPORT_LABEL, so a row with that exact label is adopted (and marked) once.
 */
const CLAUDE_CODE_MANAGED_BY = 'claude-code-cli';
const CLAUDE_CODE_MANAGED_METADATA: Readonly<Record<string, unknown>> = {
  managed_by: CLAUDE_CODE_MANAGED_BY,
};
const LEGACY_IMPORT_LABEL = 'Claude Code CLI (imported)';

interface ClaudeCodeCredentialRef {
  id: string;
  verificationStatus: 'untested' | 'ok' | 'fail';
}

export interface ClaudeCodeSyncResult {
  credential: SafeProviderCredential;
  /**
   * Outcome of the live check; `untested` when `verify` is false, or when
   * the keychain rotated again while this token was being verified, in which
   * case the result belongs to a superseded token and is discarded.
   */
  verification: 'ok' | 'fail' | 'untested';
  message: string;
}

/** The keychain-managed row (marked, or an older import row), never a manual one. */
async function findClaudeCodeCredential(): Promise<ClaudeCodeCredentialRef | undefined> {
  const rows = (await UserProviderCredentials.listAll()).filter(
    (row) =>
      row.providerId === CLAUDE_CODE_PROVIDER_ID && row.authTypeId === CLAUDE_CODE_AUTH_TYPE_ID
  );
  const marked = rows.find((row) => row.metadataJson?.managed_by === CLAUDE_CODE_MANAGED_BY);
  const legacy = rows.find((row) => row.label === LEGACY_IMPORT_LABEL);
  const row = marked ?? legacy;
  return row ? { id: row.id, verificationStatus: row.verificationStatus } : undefined;
}

/** A keychain login Snaglet can use right now: present and not past the CLI's expiry stamp. */
export async function readUsableClaudeCliAuth(fresh = true): Promise<ClaudeCliAuth | null> {
  const auth = await readClaudeCliAuthCached(fresh);
  if (!auth || !isClaudeCliAuthCurrent(auth)) return null;
  return auth;
}

/**
 * Upserts run one at a time: two concurrent syncs must not both `save` a
 * fresh row. Only the find-and-write is queued — never the live verification,
 * so a slow Anthropic call cannot hold up later imports.
 */
let upsertQueue: Promise<unknown> = Promise.resolve();
function queuedUpsert<T>(task: () => Promise<T>): Promise<T> {
  const run = upsertQueue.then(task);
  // Only the queue tail swallows; callers still see their own rejection.
  // eslint-disable-next-line no-restricted-syntax -- rejection is propagated via `run`
  upsertQueue = run.catch(() => undefined);
  return run;
}

/**
 * Mirror the given (or freshly read) keychain login into the credential store.
 * Throws a 404 AppError when there is no login to import.
 */
export async function syncClaudeCodeCredential(options: {
  verify: boolean;
  auth?: ClaudeCliAuth | null;
}): Promise<ClaudeCodeSyncResult> {
  const auth = options.auth ?? (await readClaudeCliAuthCached(true));
  if (!auth) {
    throw new AppError(
      'No Claude Code login found in the macOS keychain — sign in to Claude Code first.',
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  }
  const secret = auth.accessToken;
  await parseProviderCredentialInput({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    authTypeId: CLAUDE_CODE_AUTH_TYPE_ID,
    authType: 'oauth',
    secret,
  });

  // Upsert in place: the row is a mirror of the keychain, so a rotation
  // overwrites the secret rather than stacking a second import.
  const label = CLAUDE_CODE_CREDENTIAL_LABEL;
  const metadata = { ...CLAUDE_CODE_MANAGED_METADATA };
  const { existing, credential } = await queuedUpsert(async () => {
    const found = await findClaudeCodeCredential();
    const row = found
      ? await providerCredentialService.edit(found.id, { label, secret, metadata })
      : await providerCredentialService.save({
          providerId: CLAUDE_CODE_PROVIDER_ID,
          authTypeId: CLAUDE_CODE_AUTH_TYPE_ID,
          authType: 'oauth',
          label,
          secret,
          metadata,
        });
    // A replacement token must not inherit the previous token's verdict.
    // Keep this reset under the same lock as the write, before verification
    // runs outside it, so a later sync cannot be reset by an older one.
    if (row) await UserProviderCredentials.updateVerificationStatus(row.id, 'untested');
    return { existing: found, credential: row };
  });
  if (!credential) {
    throw new AppError(
      'Failed to persist the Claude Code credential',
      ErrorCode.INTERNAL_ERROR,
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
  logger.info(
    `[claude-code-auth] ${existing ? 'updated' : 'created'} credential ${credential.id} ` +
      `(token ${tokenFingerprint(secret)})`
  );

  if (!options.verify) {
    return {
      credential: { ...credential, verificationStatus: 'untested' },
      verification: 'untested',
      message: 'Imported from Claude Code — not tested yet.',
    };
  }

  let verification: 'ok' | 'fail';
  let message: string;
  try {
    const result = await providerChatService.verify(CLAUDE_CODE_PROVIDER_ID, secret, {
      authType: 'oauth',
      credentialId: credential.id,
    });
    verification = result.valid ? 'ok' : 'fail';
    message = result.valid ? 'Claude Code login connected and verified.' : result.message;
  } catch (err) {
    verification = 'fail';
    message = `Could not verify the Claude Code login: ${getErrorMessage(err)}`;
  }
  // The verdict is about `secret`. Write it only if that is still the stored
  // token — a rotation that landed meanwhile must not inherit it.
  const written = await writeVerificationIfCurrent(credential.id, secret, verification);
  if (!written) {
    return {
      credential: { ...credential, verificationStatus: 'untested' },
      verification: 'untested',
      message: 'Claude Code login changed while it was being verified — try again.',
    };
  }
  if (verification === 'ok') forgetRejectedToken(secret);
  return { credential: { ...credential, verificationStatus: verification }, verification, message };
}

/**
 * Under the upsert lock: set the row's verification status only while its
 * stored secret is still `token`. Returns false when the row moved on.
 */
async function writeVerificationIfCurrent(
  credentialId: string,
  token: string,
  status: 'ok' | 'fail'
): Promise<boolean> {
  return queuedUpsert(async () => {
    const stored = await providerCredentialService.getSecretById(credentialId);
    if (stored !== token) return false;
    await UserProviderCredentials.updateVerificationStatus(credentialId, status);
    return true;
  });
}

/**
 * True when a request is using the row Snaglet mirrors from Claude Code — the only
 * credential the keychain is allowed to override. Identity is decided by the
 * resolved credential id; only when the caller has none (environment
 * fallback) does the secret itself have to match the managed row's. A token
 * pasted by hand under the same auth type is never treated as managed.
 */
export async function isClaudeCodeManagedSecret(
  secret: string,
  credentialId: string | null = null
): Promise<boolean> {
  const managed = await findClaudeCodeCredential();
  if (!managed) return false;
  if (credentialId) return credentialId === managed.id;
  const stored = await providerCredentialService.getSecretById(managed.id);
  return !!stored && stored === secret;
}

/**
 * Flag any credential as failed after Anthropic rejected `rejectedToken` —
 * but only while that row still holds it. Used for tokens Snaglet cannot refresh
 * (pasted by hand), so the Providers page shows the failure and the next
 * Claude Code sign-in knows which rows it replaces.
 */
export async function markCredentialAuthFailed(
  credentialId: string,
  rejectedToken: string
): Promise<boolean> {
  return writeVerificationIfCurrent(credentialId, rejectedToken, 'fail');
}

/**
 * Flag the mirrored credential as failed so the UI stops showing it verified —
 * but only while it still holds `rejectedToken`. A 401 for a token that has
 * since been replaced says nothing about the newer one.
 */
export async function markClaudeCodeCredentialFailed(
  rejectedToken: string
): Promise<string | null> {
  const existing = await findClaudeCodeCredential();
  if (!existing) return null;
  const written = await writeVerificationIfCurrent(existing.id, rejectedToken, 'fail');
  return written ? existing.id : null;
}
