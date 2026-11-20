import { AppError, safeJsonParse } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { providerService } from '@server/services/ProviderService';
import type { SaveProviderCredentialInput } from './types';

function invalid(message: string): never {
  throw new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s|[\x00-\x1f\x7f]/.test(value);
}

/** Syntax only: deliberately does not verify signatures, expiry, or account access. */
function jwtFormat(secret: string): boolean {
  const parts = secret.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  return parts
    .slice(0, 2)
    .every((part) =>
      record(safeJsonParse<unknown>(Buffer.from(part, 'base64url').toString('utf8')))
    );
}

/** Connect is a local save. Network authentication belongs only to Test/use. */
export async function parseProviderCredentialInput(
  body: unknown
): Promise<SaveProviderCredentialInput> {
  if (!record(body)) invalid('Credential must be an object');
  for (const field of ['providerId', 'authTypeId', 'authType', 'secret'] as const) {
    if (typeof body[field] !== 'string' || !body[field].trim())
      invalid(`${field} is required and must be a non-empty string`);
  }
  if (body.label !== undefined && typeof body.label !== 'string') invalid('label must be a string');
  if (body.metadata !== undefined && !record(body.metadata)) invalid('metadata must be an object');
  const input: SaveProviderCredentialInput = {
    providerId: (body.providerId as string).trim(),
    authTypeId: (body.authTypeId as string).trim(),
    authType: (body.authType as string).trim(),
    secret: (body.secret as string).trim(),
    label: body.label as string | undefined,
    metadata: body.metadata as Record<string, unknown> | undefined,
  };
  const provider = await providerService.get(input.providerId);
  if (!provider) invalid('Unknown provider');
  const auth = provider.authTypes.find((entry) => entry.id === input.authTypeId);
  if (!auth || auth.type !== input.authType) invalid('Auth type does not belong to this provider');
  if (input.authTypeId === 'codex:codex-subscription') {
    if (!token(input.metadata?.refresh_token) || !token(input.metadata?.account_id)) {
      invalid(
        'Codex subscription requires refresh_token and account_id without whitespace in metadata'
      );
    }
    if (!jwtFormat(input.secret))
      invalid(
        'Codex access token must be a JWT with three base64url segments and JSON header/payload'
      );
  } else if (
    input.providerId === 'codex' &&
    input.authType === 'api_key' &&
    !/^sk-[A-Za-z0-9_-]+$/.test(input.secret)
  ) {
    invalid(
      'Codex API key must start with sk- and contain only letters, numbers, hyphens, or underscores'
    );
  }
  return input;
}
