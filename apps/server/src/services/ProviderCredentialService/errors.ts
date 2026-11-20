/**
 * A stored credential exists but its secret cannot be decrypted (wrong or
 * missing CREDENTIAL_ENCRYPTION_KEY, corrupt ciphertext). Unlike a database
 * error this does not heal on retry, so callers treat it as unusable.
 */
export class CredentialDecryptError extends Error {
  constructor(
    readonly credentialId: string,
    detail: string
  ) {
    super(`Credential ${credentialId} could not be decrypted: ${detail}`);
    this.name = 'CredentialDecryptError';
  }
}

export function isCredentialDecryptError(err: unknown): err is CredentialDecryptError {
  return (
    err instanceof CredentialDecryptError ||
    (err instanceof Error && err.name === 'CredentialDecryptError')
  );
}
