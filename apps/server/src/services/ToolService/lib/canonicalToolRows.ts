/**
 * canonicalToolRows: the person-facing tool catalog shows canonical ids only.
 *
 * An alias id (`exec_command` for `shell(op)`) keeps resolving for stored
 * access rules, hooks and MCP clients, and its `tools` row is kept disabled
 * (enabled=false, never deleted). Lists a person picks from or reads (the
 * Tools sidebar, the tool-access editor, the palette) drop those rows; nothing
 * here touches resolution.
 *
 * An id with a live registry definition keeps its own row, matching
 * ToolExecutor's "exact live handlers always win".
 */
import { isRetiredToolId } from '@snaglet/shared/utils';
import { toolRegistry } from '../ToolRegistry';

const liveToolIds = (): ReadonlySet<string> => new Set(toolRegistry.getToolIds());

/** True when `id` is an alias or removed id a person should not be offered. */
export function isRetiredToolRow(id: string): boolean {
  return isRetiredToolId(id, liveToolIds());
}

/** `rows` without alias ids and removal tombstones. */
export function canonicalToolRows<T extends { id: string }>(rows: readonly T[]): T[] {
  const live = liveToolIds();
  return rows.filter((row) => !isRetiredToolId(row.id, live));
}

/** Resolved agent tools without alias ids and removal tombstones. */
export function canonicalAgentTools<T extends { tool: { id: string } }>(rows: readonly T[]): T[] {
  const live = liveToolIds();
  return rows.filter(({ tool }) => !isRetiredToolId(tool.id, live));
}
