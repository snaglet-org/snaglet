import { Providers } from '@snaglet/db/tables/providers';
import type { SafeProviderCredential, SaveProviderCredentialInput } from './types';
import { listSafeCredentials, saveCredential, updateCredentialSecret } from './credentials';

const TEST_CREDENTIAL_SEED_ENV = 'SNAGLET_SEED_TEST_CREDENTIALS';

interface EnvironmentCredentialSeed extends SaveProviderCredentialInput {
  sourceEnvVars: readonly string[];
}

export interface EnvironmentCredentialSeedReport {
  enabled: boolean;
  created: number;
  updated: number;
  primaryAssigned: number;
  providers: string[];
  sourceEnvVars: string[];
}

interface SimpleEnvironmentCredential {
  envVar: string;
  providerId: string;
  authTypeId: string;
  providerLabel: string;
}

const SIMPLE_ENVIRONMENT_CREDENTIALS: readonly SimpleEnvironmentCredential[] = [
  {
    envVar: 'ANTHROPIC_API_KEY',
    providerId: 'anthropic',
    authTypeId: 'anthropic:api-key',
    providerLabel: 'Anthropic',
  },
  {
    envVar: 'OPENAI_API_KEY',
    providerId: 'openai',
    authTypeId: 'openai:api-key',
    providerLabel: 'OpenAI',
  },
  {
    envVar: 'TOGETHER_API_KEY',
    providerId: 'together',
    authTypeId: 'together:api-key',
    providerLabel: 'Together',
  },
  {
    envVar: 'MISTRAL_API_KEY',
    providerId: 'mistral',
    authTypeId: 'mistral:api-key',
    providerLabel: 'Mistral',
  },
  {
    envVar: 'GEMINI_API_KEY',
    providerId: 'google',
    authTypeId: 'google:api-key',
    providerLabel: 'Gemini',
  },
  {
    envVar: 'DEEPSEEK_API_KEY',
    providerId: 'deepseek',
    authTypeId: 'deepseek:api-key',
    providerLabel: 'DeepSeek',
  },
  {
    envVar: 'XAI_API_KEY',
    providerId: 'xai',
    authTypeId: 'xai:api-key',
    providerLabel: 'xAI',
  },
] as const;

function readEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function testCredentialLabel(providerLabel: string): string {
  return `Test credential: ${providerLabel} environment`;
}

export function shouldSeedEnvironmentTestCredentials(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.NODE_ENV === 'development' || env[TEST_CREDENTIAL_SEED_ENV] === '1';
}

export function collectEnvironmentTestCredentials(
  env: NodeJS.ProcessEnv
): EnvironmentCredentialSeed[] {
  const seeds: EnvironmentCredentialSeed[] = [];

  for (const definition of SIMPLE_ENVIRONMENT_CREDENTIALS) {
    const secret = readEnvironmentValue(env, definition.envVar);
    if (!secret) continue;
    seeds.push({
      providerId: definition.providerId,
      authTypeId: definition.authTypeId,
      authType: 'api_key',
      label: testCredentialLabel(definition.providerLabel),
      secret,
      sourceEnvVars: [definition.envVar],
    });
  }

  const codexAccessToken = readEnvironmentValue(env, 'CODEX_ACCESS_TOKEN');
  if (codexAccessToken) {
    const metadata: Record<string, unknown> = {};
    const refreshToken = readEnvironmentValue(env, 'CODEX_REFRESH_TOKEN');
    const accountId = readEnvironmentValue(env, 'CODEX_ACCOUNT_ID');
    if (refreshToken) metadata.refresh_token = refreshToken;
    if (accountId) metadata.account_id = accountId;

    seeds.push({
      providerId: 'codex',
      authTypeId: 'codex:codex-subscription',
      authType: 'oauth',
      label: testCredentialLabel('Codex'),
      secret: codexAccessToken,
      metadata,
      sourceEnvVars: [
        'CODEX_ACCESS_TOKEN',
        ...(refreshToken ? ['CODEX_REFRESH_TOKEN'] : []),
        ...(accountId ? ['CODEX_ACCOUNT_ID'] : []),
      ],
    });
  }

  const copilotSecret = readEnvironmentValue(env, 'COPILOT_SECRET');
  const copilotToken = readEnvironmentValue(env, 'COPILOT_TOKEN');
  const copilotPrimarySecret = copilotSecret ?? copilotToken;
  if (copilotPrimarySecret) {
    const metadata: Record<string, unknown> = {};
    const baseUrl = readEnvironmentValue(env, 'COPILOT_BASE_URL');
    const expiresAt = readEnvironmentValue(env, 'COPILOT_EXPIRES_AT');
    if (copilotToken) metadata.copilot_token = copilotToken;
    if (baseUrl) metadata.copilot_base_url = baseUrl;
    if (expiresAt) metadata.copilot_expires_at = expiresAt;

    seeds.push({
      providerId: 'copilot',
      authTypeId: 'copilot:subscription',
      authType: 'oauth',
      label: testCredentialLabel('Copilot'),
      secret: copilotPrimarySecret,
      metadata,
      sourceEnvVars: [
        ...(copilotSecret ? ['COPILOT_SECRET'] : []),
        ...(copilotToken ? ['COPILOT_TOKEN'] : []),
        ...(baseUrl ? ['COPILOT_BASE_URL'] : []),
        ...(expiresAt ? ['COPILOT_EXPIRES_AT'] : []),
      ],
    });
  }

  return seeds;
}

function findOwnedCredential(
  credentials: readonly SafeProviderCredential[],
  seed: EnvironmentCredentialSeed
): SafeProviderCredential | undefined {
  return credentials.find(
    (credential) =>
      credential.providerId === seed.providerId &&
      credential.authTypeId === seed.authTypeId &&
      credential.label === seed.label
  );
}

/**
 * Import ambient development credentials through Snaglet's normal encrypted
 * credential service. The stable test label is the ownership boundary:
 * subsequent boots update only the row created by this bootstrap and never
 * overwrite a user-authored credential.
 */
export async function seedEnvironmentTestCredentials(
  env: NodeJS.ProcessEnv = process.env
): Promise<EnvironmentCredentialSeedReport> {
  if (!shouldSeedEnvironmentTestCredentials(env)) {
    return {
      enabled: false,
      created: 0,
      updated: 0,
      primaryAssigned: 0,
      providers: [],
      sourceEnvVars: [],
    };
  }

  const seeds = collectEnvironmentTestCredentials(env);
  if (seeds.length === 0) {
    return {
      enabled: true,
      created: 0,
      updated: 0,
      primaryAssigned: 0,
      providers: [],
      sourceEnvVars: [],
    };
  }

  const credentials = await listSafeCredentials();
  let created = 0;
  let updated = 0;
  let primaryAssigned = 0;

  for (const seed of seeds) {
    const existing = findOwnedCredential(credentials, seed);
    let credentialId: string;
    if (existing) {
      await updateCredentialSecret(existing.id, seed.secret, seed.metadata ?? {});
      credentialId = existing.id;
      updated += 1;
    } else {
      const credential = await saveCredential(seed);
      credentials.push(credential);
      credentialId = credential.id;
      created += 1;
    }

    const provider = await Providers.findProvider(seed.providerId);
    if (provider && provider.primaryCredentialId === null) {
      await Providers.updatePrimaryCredential(seed.providerId, credentialId);
      primaryAssigned += 1;
    }
  }

  return {
    enabled: true,
    created,
    updated,
    primaryAssigned,
    providers: seeds.map((seed) => seed.providerId),
    sourceEnvVars: Array.from(new Set(seeds.flatMap((seed) => seed.sourceEnvVars))),
  };
}
