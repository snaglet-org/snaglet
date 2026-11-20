import type { ProviderVerifyResult } from '../../types';

/** Local daemons are optional. An offline server is a failed check, not an API error. */
export async function verifyLocalServer(
  url: string,
  name: string,
  environmentVariable: string
): Promise<ProviderVerifyResult> {
  const help = `Start the ${name} server, or check ${environmentVariable} if you use a different server URL. No API key is needed.`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    // We only need reachability/status, not the models payload.
    await response.body?.cancel();
    if (!response.ok) {
      return { valid: false, message: `${name} returned HTTP ${response.status}. ${help}` };
    }
    return { valid: true, message: 'Connected successfully' };
  } catch (error: unknown) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `${name} did not respond within 8 seconds.`
        : `${name} could not be reached.`;
    return { valid: false, message: `${reason} ${help}` };
  }
}
