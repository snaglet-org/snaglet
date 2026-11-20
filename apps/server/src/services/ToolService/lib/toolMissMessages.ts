/**
 * toolMissMessages — what a model reads when it calls a tool its run cannot
 * route. An agent told "unavailable or not permitted" concluded the tool was
 * gone and told the user it had "lost access"; each message here says which
 * case it is and the next step instead: search for it, say it is blocked (and
 * where the user can allow it), or create one. toolDiscoveryBlock states the
 * same rule in the system prompt.
 */

const SEARCH_STEP =
  "search with tool({op: 'search', query: '<the thing or the verb>'}) and call what it finds with action({tool: '<id>', params: {...}})";
const NEVER =
  "Never tell the user you can't do something, or that a tool is missing or lost, until you have searched.";

/**
 * No tool by this name is in the run's reachable set (and none exists that
 * the agent's access blocks, when that was checked).
 */
export function unknownToolMessage(name: string, options: { canCreate: boolean }): string {
  const nothingFits = options.canCreate
    ? "If nothing fits, create one with custom_tool({op: 'create', name, description, parameters_schema, handler_source})."
    : 'If nothing fits, tell the user what tool you need.';
  return `No tool named '${name}' is loaded for you. Your tool list holds only the tools loaded now: ${SEARCH_STEP}. ${nothingFits} ${NEVER}`;
}

/** The tool exists, but this agent's own tool access (allow or deny list) hides it. */
export function blockedToolMessage(toolId: string, agentName: string | null | undefined): string {
  const who = agentName?.trim() || 'your agent';
  return `Tool '${toolId}' exists, but this agent's tool access blocks it. It was not removed and you did not lose access: tell the user it is blocked by your permissions; they can allow it in Agents → ${who} → Capabilities.`;
}

/** The tool exists and the agent may use it, but this thread's tool access blocks it. */
export function threadBlockedToolMessage(toolId: string): string {
  return `Tool '${toolId}' is not allowed in this thread (thread tool access). It still exists: tell the user it is blocked here; they can allow it in this thread's settings → Agents.`;
}

/**
 * The executor-level `action` gateway (SDK scripts, hook and custom-tool
 * children) cannot tell a missing tool from a hidden one, so it keeps the
 * plain verdict and adds the next step.
 */
export function gatewayMissMessage(name: string): string {
  return `Tool '${name}' is unavailable or not permitted for this agent. If you need it, ${SEARCH_STEP}; a tool your access blocks is listed there under \`blocked\`.`;
}
