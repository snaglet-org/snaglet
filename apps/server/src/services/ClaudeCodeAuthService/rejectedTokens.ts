/**
 * Tokens Anthropic has rejected, by fingerprint. Shared by recovery (which
 * adds and consults them) and sync (which clears one when an explicit
 * verification succeeds, so the Providers page and chat never disagree about
 * the same token).
 */

import { tokenFingerprint } from '@server/services/ProviderChatService/providers/claudeCliAuth';

const rejected = new Set<string>();

export function rememberRejectedToken(token: string): void {
  rejected.add(tokenFingerprint(token));
}

export function isRejectedToken(token: string): boolean {
  return rejected.has(tokenFingerprint(token));
}

export function forgetRejectedToken(token: string): void {
  rejected.delete(tokenFingerprint(token));
}

export function forgetAllRejectedTokens(): void {
  rejected.clear();
}
