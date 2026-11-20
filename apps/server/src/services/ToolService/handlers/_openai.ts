import type { ToolHandler } from '../types';
import { providerCredentialService } from '@server/services/ProviderCredentialService';

export async function resolveOpenAISecret(
  context?: Parameters<ToolHandler>[2]
): Promise<string | null> {
  if (
    context?.runtime?.apiKey &&
    (context.runtime.provider === 'openai' || context.runtime.provider === 'codex')
  ) {
    return context.runtime.apiKey;
  }

  try {
    const stored = await providerCredentialService.getSecret('openai');
    if (stored) return stored;
  } catch {
    // Fall through to env lookup.
  }

  return process.env.OPENAI_API_KEY ?? null;
}

export async function requireOpenAISecret(context?: Parameters<ToolHandler>[2]): Promise<string> {
  const secret = await resolveOpenAISecret(context);
  if (!secret) {
    throw new Error('An OpenAI API key or openai provider credential is required');
  }
  return secret;
}
