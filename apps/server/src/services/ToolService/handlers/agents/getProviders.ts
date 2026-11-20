/**
 * get_providers — list configured LLM provider credentials (secrets stripped).
 *
 * Reads from providerCredentialService.listSafe(), the same safe view the
 * Providers UI consumes. No secret material is ever exposed.
 */
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import type { ToolHandler } from '@server/services/ToolService/types';

const handler: ToolHandler = async () => {
  const credentials = await providerCredentialService.listSafe();

  if (credentials.length === 0) {
    return {
      output: 'No providers are configured in this workspace.',
      rawContent: { providers: [] },
    };
  }

  const lines = credentials.map((cred) => {
    const secret = cred.hasSecret ? 'secret set' : 'no secret';
    return `- ${cred.providerId} — ${cred.label} (auth: ${cred.authType}, ${secret}, verification: ${cred.verificationStatus})`;
  });

  return {
    output: `${credentials.length} provider credential(s) configured:\n${lines.join('\n')}`,
    rawContent: {
      providers: credentials.map((cred) => ({
        id: cred.id,
        providerId: cred.providerId,
        authType: cred.authType,
        label: cred.label,
        hasSecret: cred.hasSecret,
        verificationStatus: cred.verificationStatus,
        updatedAt: cred.updatedAt,
      })),
    },
  };
};

export default handler;
