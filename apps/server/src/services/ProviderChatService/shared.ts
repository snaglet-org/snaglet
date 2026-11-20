import type { SnagletAgent } from '../AgentService';
import { providerCredentialService } from '../ProviderCredentialService';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { CLAUDE_CLI_FALLBACK_VERSION } from './providers/claudeCliVersion';

const SHOULD_LOG_PROVIDER_PAYLOADS =
  process.env.LOG_PROVIDER_PAYLOADS === 'true' || process.env.LOG_LLM_PAYLOADS === 'true';
const SHOULD_LOG_FULL_PROVIDER_PAYLOADS = process.env.LOG_PROVIDER_FULL_PAYLOADS === 'true';

/** Map alias ids to their canonical provider id; unknown ids pass through. */
export function normalizeProviderId(providerRaw: string): string {
  const provider = (providerRaw || '').toLowerCase().trim();
  if (provider === 'gemini') return 'google';
  if (provider === 'github-copilot') return 'copilot';
  return provider;
}

export async function pickSecret(agent: SnagletAgent): Promise<string> {
  // A configured credential is pinned. If it disappears or cannot decrypt,
  // return empty so the provider's assertSecret fails visibly; never borrow a
  // provider-default or environment credential behind the user's back.
  if (agent.credentialId) {
    const fromId = await providerCredentialService.getSecretById(agent.credentialId);
    return fromId ?? '';
  }

  const fromCredentialStore = await providerCredentialService.getSecret(agent.provider);
  if (fromCredentialStore) return fromCredentialStore;

  // Environment fallback for local/dev bootstrap, declared per provider in
  // the registry. Anthropic intentionally declares none — its credentials
  // come only from the DB credential store (above); with no DB credential,
  // pickSecret returns '' and assertSecret prompts the user to connect it.
  // Dynamic import: providers/* import this module at load time, so a
  // top-level registry import would create a cycle.
  const { PROVIDER_REGISTRY } = await import('./providers/registry');
  const provider = normalizeProviderId(agent.provider);
  for (const envVar of PROVIDER_REGISTRY[provider]?.envSecretVars ?? []) {
    const value = process.env[envVar];
    if (value) return value;
  }
  return '';
}

/**
 * Which stored credential `pickSecret` resolved for this agent: the pinned id,
 * else the provider's default row, else null (environment fallback). Lets
 * per-credential behavior (Claude Code keychain sync) key off identity rather
 * than guessing from the secret's shape.
 */
export async function pickCredentialId(agent: SnagletAgent): Promise<string | null> {
  if (agent.credentialId) return agent.credentialId;
  return providerCredentialService.getDefaultCredentialId(agent.provider);
}

export function assertSecret(secret: string, provider: string): void {
  if (!secret) {
    throw new Error(
      `Missing credentials for provider '${provider}'. Connect it on the Providers page.`
    );
  }
}

export function isAnthropicOAuthToken(value: string): boolean {
  return value.includes('sk-ant-oat');
}

// Anthropic's JSON parser rejects unpaired UTF-16 surrogates with "no low surrogate in string".
// They sneak in via pasted/truncated emoji or 4-byte chars; replace each lone half with U+FFFD.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function scrubLoneSurrogates<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(LONE_SURROGATE_RE, '�') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrubLoneSurrogates) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubLoneSurrogates(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Parse the accumulated streamed tool-input JSON into the object the tool
 * dispatcher receives.
 *
 * The streamed `partial_json` deltas occasionally assemble into a string that
 * `JSON.parse` rejects, most often because of a lone UTF-16 surrogate
 * (pasted/truncated emoji inside a `command` or file `content`). Lone
 * surrogates are scrubbed before parsing (as for the outbound request body);
 * a genuine parse failure throws a diagnostic error (length + bounded
 * snippet) rather than returning `{}`, which would silently drop every param
 * and surface later as a misleading "command/path is required".
 *
 * Empty / whitespace-only input returns `{}` (a tool call with no arguments).
 */
export function parseToolInputJson(raw: string): Record<string, unknown> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  const scrubbed = scrubLoneSurrogates(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(scrubbed);
  } catch (err) {
    const snippet = scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed;
    throw new Error(
      `Failed to parse streamed tool-input JSON (${scrubbed.length} chars): ` +
        `${getErrorMessage(err)}. Raw snippet: ${snippet}`
    );
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  // A non-object top-level value (array, string, number) is not a valid
  // tool-arguments shape; treat as no-args rather than crashing the stream.
  return {};
}

/**
 * Build Anthropic request headers + system payload for an OAuth-aware call.
 *
 * When using a Pro/Max OAuth token on a non-Haiku model, Anthropic requires
 * the Claude Code identity contract: the `claude-code-20250219` beta flag,
 * `x-app: cli`, `User-Agent: claude-cli/*`, and a system prompt whose first
 * block is the Claude Code identity line. Missing any piece results in bare
 * 429s from the OAuth edge with no rate-limit reset headers.
 *
 * API-key callers get the standard `x-api-key` path with prompt caching.
 *
 * `claudeCliVersion` is the installed CLI's version (see claudeCliVersion.ts);
 * Anthropic rejects newer models for an older `claude-cli/*` identity.
 */
export function buildAnthropicAuthedRequest(args: {
  secret: string;
  model: string;
  system: string;
  systemBlocks?: Array<{ type: 'text'; text: string; cache_control?: unknown }>;
  claudeCliVersion?: string;
}): { headers: Record<string, string>; system: unknown } {
  const { secret, model, system } = args;
  const isOAuth = isAnthropicOAuthToken(secret);
  const isNonHaiku = !model.includes('haiku');
  // extended-cache-ttl: Snaglet marks breakpoints with ttl '1h' — without this
  // beta the API may silently coerce them to the
  // 5-minute default, which a coffee break then expires.
  const betaTokens: string[] = ['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11'];

  if (isOAuth) {
    betaTokens.push('oauth-2025-04-20');
    if (isNonHaiku) betaTokens.push('claude-code-20250219');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betaTokens.join(','),
  };

  if (isOAuth) {
    headers['Authorization'] = `Bearer ${secret}`;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    if (isNonHaiku) {
      headers['x-app'] = 'cli';
      headers['User-Agent'] = `claude-cli/${args.claudeCliVersion ?? CLAUDE_CLI_FALLBACK_VERSION}`;
    }
  } else {
    headers['x-api-key'] = secret;
  }

  let systemPayload: unknown;
  if (args.systemBlocks && args.systemBlocks.length > 0) {
    const blocks = args.systemBlocks.filter((block) => block.text.trim().length > 0);
    if (isOAuth && isNonHaiku) {
      blocks.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      });
    }
    systemPayload = blocks;
  } else if (isOAuth && isNonHaiku) {
    systemPayload = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: system },
    ].filter((block) => block.text.trim().length > 0);
  } else {
    systemPayload = system;
  }

  return { headers, system: systemPayload };
}

function redactHeaderValue(key: string, value: string): string {
  const normalized = key.toLowerCase();
  if (
    normalized === 'authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'chatgpt-account-id'
  ) {
    return '[REDACTED]';
  }
  return value;
}

const PROVIDER_LOG_TEXT_LIMIT = 1200;

function previewProviderValue(value: unknown, limit = PROVIDER_LOG_TEXT_LIMIT): unknown {
  if (typeof value === 'string') {
    return value.length > limit
      ? `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => previewProviderValue(item, Math.max(200, Math.floor(limit / 2))));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        previewProviderValue(nested, Math.max(200, Math.floor(limit / 2))),
      ])
    );
  }
  return value;
}

function summarizeConversationArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const latest = value[value.length - 1] ?? null;
  return {
    count: value.length,
    omitted: Math.max(0, value.length - 1),
    latest: previewProviderValue(latest),
  };
}

function summarizeProviderBody(body: Record<string, unknown>): Record<string, unknown> {
  if (SHOULD_LOG_FULL_PROVIDER_PAYLOADS) return body;

  const summarized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'messages' || key === 'input') {
      summarized[key] = summarizeConversationArray(value);
    } else if (key === 'system' || key === 'instructions') {
      summarized[key] = previewProviderValue(value, 600);
    } else {
      summarized[key] = previewProviderValue(value);
    }
  }
  return summarized;
}

export function logProviderPayload(
  provider: string,
  agent: SnagletAgent,
  body: Record<string, unknown>,
  headers?: Record<string, string>
): void {
  if (!SHOULD_LOG_PROVIDER_PAYLOADS) return;

  const safeHeaders = headers
    ? Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, redactHeaderValue(key, value)])
      )
    : undefined;

  const envelope = {
    provider,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.modelId ?? null,
    headers: safeHeaders,
    body: summarizeProviderBody(body),
  };

  logger.info(
    `[provider-payload] 
        ${provider}
        ${agent.modelId ?? 'unknown'}
        ${JSON.stringify(envelope, null, 2)}
    [provider-payload]`
  );
}
