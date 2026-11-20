/**
 * GitHub personal access token verifier.
 *
 * GitHub is not an LLM provider, but the Providers page's Test/Save flow
 * still routes through `providerChatService.verify`. To return a real
 * pass/fail we hit `/user` — the cheapest authenticated endpoint —
 * which returns 200 only when the token is valid.
 */

import type { ProviderVerifyResult } from '@server/services/ProviderChatService/types';
import { getErrorMessage } from '@snaglet/shared/utils';

const GITHUB_API_URL = 'https://api.github.com/user';

export async function verifyGitHub(secret: string): Promise<ProviderVerifyResult> {
  const token = secret?.trim();
  if (!token) {
    return { valid: false, message: 'GitHub token is empty.' };
  }

  try {
    const res = await fetch(GITHUB_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Snaglet',
      },
    });

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        login?: string;
        name?: string;
      };
      const who = body.login ?? body.name ?? 'GitHub user';
      const scopes = res.headers.get('x-oauth-scopes')?.trim();
      return {
        valid: true,
        message: scopes ? `Connected as ${who} (scopes: ${scopes})` : `Connected as ${who}`,
      };
    }

    const errBody = (await res.json().catch(() => ({}))) as { message?: string };
    const detail = errBody.message || `HTTP ${res.status} ${res.statusText}`.trim();
    return { valid: false, message: `GitHub rejected the token: ${detail}` };
  } catch (err) {
    const message = getErrorMessage(err);
    return { valid: false, message: `Could not reach GitHub API: ${message}` };
  }
}
