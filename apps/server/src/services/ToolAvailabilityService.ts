import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAvailability } from '@snaglet/shared/types';
import { Providers } from '@snaglet/db/tables/providers';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';

// The availability union is the shared wire schema — see
// packages/shared/types/tools.ts. Re-exported for existing import sites.
export type { ToolAvailability };

const DARWIN_ONLY_TOOL_IDS = new Set(['ocr_image']);

/**
 * Platform requirements belong to the installed implementation, rather than
 * the persisted `enabled` policy. This lets one workspace retain its tool
 * catalog while each desktop reports what it can actually run.
 */
export function isToolSupportedOnPlatform(toolId: string, platform: NodeJS.Platform): boolean {
  return !DARWIN_ONLY_TOOL_IDS.has(toolId) || platform === 'darwin';
}

/**
 * Availability gate for persisted (builtin) tools. MCP tools are not
 * persisted as `tools` rows — they're resolved live by `resolveAgentTools` and
 * bypass this gate entirely — so this only handles builtin tools and their
 * integration-provider credential requirements.
 */
export async function getToolAvailability(
  tool: ToolRow,
  platform: NodeJS.Platform = process.platform
): Promise<ToolAvailability> {
  if (!tool.enabled) return 'disabled';
  if (!isToolSupportedOnPlatform(tool.id, platform)) return 'unsupported_platform';
  if (!tool.providerId) return 'available';

  const provider = await Providers.findById(tool.providerId);
  if (provider?.type === 'integration' && !provider.enabled) return 'integration_disabled';

  if (provider?.type === 'integration') {
    const credential = await UserProviderCredentials.findByProviderId(tool.providerId);
    if (!credential) return 'missing_credential';
  }
  return 'available';
}

export async function decorateToolAvailability<T extends ToolRow>(
  tool: T
): Promise<T & { availability: ToolAvailability }> {
  return { ...tool, availability: await getToolAvailability(tool) };
}
