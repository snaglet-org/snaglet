/**
 * Tool access for calendar calls. The calendar shows things other tools own,
 * so the calendar tool gives an agent exactly the access those tools give:
 *
 * - A table row on the calendar is a row of a custom table: rows show in a
 *   query only when the agent may run `table {op: "read"}`, an occurrence
 *   write needs `table {op: "write"}` (the same write as table's `repeat`
 *   step), and reminders on a row need read.
 * - An automation wake belongs to the `automation` tool: wakes and Every
 *   lines show in a query, and reminders on an automation (get and set) are
 *   allowed, only when the agent may run `automation {op: "list"}`, that
 *   tool's read of every schedule.
 *
 * The verdict is the gate the action gateway and /api/tools/execute apply
 * (agentToolPolicy.evaluateAgentHeadlessToolCall): the agent's policy (a
 * subagent helper's is its orchestrator's), bare denies, op-scoped rules
 * such as `deny: table_read`, and visibility. Anything but `allow` refuses,
 * as nobody can be asked mid-call. A person (no agent context, or the panel
 * acting as an agent) has every access, as on the calendar pane. An external
 * MCP client is not that person: its access is derived from the MCP
 * curation of the table and automation tools (externalCalendarAccess), and
 * set_reminders on an automation is own-only while automation update is.
 * The domain functions still apply their own checks (custom tables only, not
 * archived).
 */
import { Automations } from '@snaglet/db/tables/automations';
import { Tools } from '@snaglet/db/tables/tools';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import {
  externalCalendarAccess,
  type ExternalCalendarAccess,
  type ExternalCuration,
} from '@server/domains/mcp/mcpProjection';
import { getCurrentActor } from '@server/realtime/actorContext';
import { evaluateAgentHeadlessToolCall } from '@server/services/ToolService/lib/agentToolPolicy';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

export type TableAccessNeed = 'read' | 'write';

interface AccessVerdict {
  allowed: boolean;
  /** Why not, when refused. */
  reason?: string;
}

/** The access one calendar call runs with; each tool op is judged once. */
export interface CalendarCaller {
  /** The agent the call runs as, or null for a person. */
  agentId: string | null;
  tableAccess(need: TableAccessNeed): Promise<AccessVerdict>;
  /** Whether the caller may read automations (`automation {op: "list"}`). */
  automationAccess(): Promise<AccessVerdict>;
  /**
   * Whether the caller may change automation `automationId`'s reminders, on
   * top of automationAccess. In the app reading is enough; an external MCP
   * client needs the curated automation write.
   */
  automationWriteAccess(automationId: string): Promise<AccessVerdict>;
}

const TABLE_TOOL_ID = 'table';
const AUTOMATION_TOOL_ID = 'automation';
/** The automation tool's read of every schedule. */
const AUTOMATION_READ_OP = 'list';
const ALLOWED: Promise<AccessVerdict> = Promise.resolve({ allowed: true });

async function judge(agentId: string, toolId: string, op: string): Promise<AccessVerdict> {
  const tool = await Tools.findById(toolId);
  if (!tool || !tool.enabled) return { allowed: false, reason: `the ${toolId} tool is turned off` };
  const verdict = await evaluateAgentHeadlessToolCall(
    agentId,
    tool,
    { op },
    { activeToolIds: new Set(toolRegistry.getToolIds()) }
  );
  return verdict.decision === 'allow'
    ? { allowed: true }
    : { allowed: false, reason: verdict.reason ?? `${toolId} ${op} is not allowed` };
}

/**
 * An external MCP client: the gateway runs it as the ambient `external`
 * actor, whose id is the key's member. It gets what the curation gives the
 * table and automation tools; an own-only automation write is checked
 * against the automation's creator, as the gateway checks automation's own
 * writes.
 */
function externalCaller(memberId: string, access: ExternalCalendarAccess): CalendarCaller {
  const curated = (allowed: boolean, toolOp: string): Promise<AccessVerdict> =>
    allowed
      ? ALLOWED
      : Promise.resolve({
          allowed: false,
          reason: `${toolOp} is not available to external MCP clients`,
        });
  return {
    agentId: null,
    tableAccess: (need) =>
      curated(need === 'read' ? access.tableRead : access.tableWrite, `${TABLE_TOOL_ID} ${need}`),
    automationAccess: () =>
      curated(access.automationRead, `${AUTOMATION_TOOL_ID} ${AUTOMATION_READ_OP}`),
    automationWriteAccess: async (automationId) => {
      if (access.automationWrite !== 'own')
        return curated(access.automationWrite === 'any', `${AUTOMATION_TOOL_ID} update`);
      // A missing automation is left to the reminder item's own not-found.
      const automation = await Automations.findById(automationId);
      if (!automation || automation.createdByMemberId === memberId) return { allowed: true };
      return {
        allowed: false,
        reason:
          "external MCP clients change only automations their key's member created; " +
          'change this one from the Snaglet app',
      };
    },
  };
}

/**
 * The caller of one calendar call. `curation` stands in for the MCP
 * curation an external caller's access is derived from (tests narrow it).
 */
export function calendarCaller(
  context?: ToolHandlerContext,
  curation?: Partial<ExternalCuration>
): CalendarCaller {
  const agentId = context?.agentId && !context.bypassToolAccess ? context.agentId : null;
  const actor = agentId === null ? getCurrentActor() : undefined;
  if (actor?.actorKind === 'external') {
    return externalCaller(actor.actorId, externalCalendarAccess(curation));
  }
  const verdicts = new Map<string, Promise<AccessVerdict>>();
  const access = (toolId: string, op: string): Promise<AccessVerdict> => {
    if (agentId === null) return ALLOWED;
    const key = `${toolId}:${op}`;
    let verdict = verdicts.get(key);
    if (!verdict) {
      verdict = judge(agentId, toolId, op);
      verdicts.set(key, verdict);
    }
    return verdict;
  };
  return {
    agentId,
    tableAccess: (need) => access(TABLE_TOOL_ID, need),
    automationAccess: () => access(AUTOMATION_TOOL_ID, AUTOMATION_READ_OP),
    automationWriteAccess: () => ALLOWED,
  };
}

function refused(what: string, needs: string, reason: string | undefined): AppError {
  return new AppError(
    `${what} needs ${needs} access, which your tool access does not give (${reason}). Nothing was changed.`,
    ErrorCode.FORBIDDEN,
    HTTP_STATUS.FORBIDDEN
  );
}

/** A 403 unless the caller has `need` table access; `what` names the action refused. */
export async function assertTableAccess(
  caller: CalendarCaller,
  need: TableAccessNeed,
  what: string
): Promise<void> {
  const verdict = await caller.tableAccess(need);
  if (!verdict.allowed) throw refused(what, `table ${need}`, verdict.reason);
}

/** A 403 unless the caller may read automations; `what` names the action refused. */
export async function assertAutomationAccess(caller: CalendarCaller, what: string): Promise<void> {
  const verdict = await caller.automationAccess();
  if (!verdict.allowed) throw refused(what, 'automation read', verdict.reason);
}

/** A 403 unless the caller may change automation `automationId`; `what` names the action. */
export async function assertAutomationWriteAccess(
  caller: CalendarCaller,
  automationId: string,
  what: string
): Promise<void> {
  const verdict = await caller.automationWriteAccess(automationId);
  if (!verdict.allowed) throw refused(what, 'automation write', verdict.reason);
}
