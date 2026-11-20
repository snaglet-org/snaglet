import { Tools, type ToolRow } from '@snaglet/db/tables/tools';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, safeJsonParse } from '@snaglet/shared/utils';
import { decorateToolAvailability } from '@server/services/ToolAvailabilityService';
import { decorateToolExecutionMetadata } from '@server/services/ToolService/lib/executionMetadata';

/**
 * A persisted tool row with its read-time availability and static execution
 * metadata: the one shape the list, get, enable and tool-workspace
 * create/save/deploy routes answer with, so the row a client gets back from
 * Create tool is the row the tool page and sidebar render after a reload.
 */
export async function decorateToolRow(row: ToolRow) {
  return decorateToolExecutionMetadata(await decorateToolAvailability(row));
}

export async function syncDefinitionToDb(
  toolId: string,
  definitionJson: string,
  opts: { enabled: boolean; configJson?: Record<string, unknown> }
) {
  const definition = safeJsonParse<Record<string, unknown> | null>(definitionJson, null);
  if (definition === null) {
    throw new AppError(
      'Invalid definition.json — must be valid JSON',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const row = await Tools.upsertTool({
    id: (definition.name as string)?.replace(/-/g, '_') ?? toolId.replace(/-/g, '_'),
    name: (definition.name as string) ?? toolId,
    description: (definition.description as string) ?? '',
    type: 'external',
    categoryPath: (definition.categoryPath as string) ?? 'custom',
    providerId: (definition.providerId as string) ?? null,
    tier: (definition.tier as 'core' | 'standard') ?? 'standard',
    parametersSchema: (definition.parametersSchema as Record<string, unknown>) ?? {},
    keywords: (definition.keywords as string[]) ?? [],
    source: `workspace:${toolId}`,
    sortOrder: 0,
    enabled: opts.enabled,
    configJson: opts.configJson ?? {},
  });
  // upsertTool deliberately preserves enabled on conflict for MCP/admin policy.
  // A workspace lifecycle request is the explicit owner of this state.
  return (await Tools.setEnabled(row.id, opts.enabled)) ?? row;
}
