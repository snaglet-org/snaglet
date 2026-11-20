/**
 * Type definitions for tools and per-agent tool resolution.
 */

import type {
  CreateToolInput,
  ToolAvailability,
  ToolExecutionMetadata,
  ToolRow as SharedToolRow,
  UpdateToolInput,
} from '@snaglet/shared/types';

export type { CreateToolInput, ToolAvailability, UpdateToolInput };

/**
 * Tool row as the list/describe and tool-workspace save/deploy payloads
 * deliver it: the shared persisted row (packages/shared/types/tools.ts)
 * decorated server-side with `availability` and the static
 * ToolExecutionMetadata fields (contextRequirement / destructive /
 * dispatchOnly — absent for MCP/external tools and unmarked builtins; treat
 * absence as 'none' / false).
 */
export interface ToolRow extends SharedToolRow, ToolExecutionMetadata {
  availability: ToolAvailability;
}
