/**
 * toolDiscoveryBlock — "search before you say no", second in the prompt.
 *
 * The native tool list is the small core set (CORE_TOOL_ORDER); every other
 * tool the agent may use is reached by `tool` search and called through the
 * `action` gateway. Agents that did not see a tool in that list told the user
 * they couldn't do the thing, or that they had "lost access", when the tool
 * was one search away. So the rule sits right after identity, before the long
 * how-to-work material, and reads as a hard rule: a short checklist, one
 * emphatic rule (search before declaring a capability unavailable; report a
 * failed call's actual error, never assume access was lost) and a worked
 * example. Creating a missing tool is offered as an option, not the automatic
 * next step, and its fields are left to the custom_tool schema.
 *
 * The same rule is repeated where an agent reads it again mid-conversation:
 * the `tool` description, the search result, the unknown-tool error
 * (toolDispatch) and one line in the per-turn context tail
 * (toolDiscoveryReminder below).
 *
 * Branches only on agent-fixed facts, so the bytes stay in the cached prefix:
 * helper or not, the agent's name, and whether `tool`, `action` and
 * `custom_tool` are in its advertised set (the base-access catalog, identical
 * in every thread). A run whose model cannot call tools advertises nothing and
 * gets no block. Without `tool` the block never tells the agent to search.
 */

import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import { isHelperRun } from '../helperRun';
import type { BlockBuilder } from '../types';

/** Ids as they exist in the registry; the block test checks each one. */
const SEARCH_TOOL_ID = 'tool';
const GATEWAY_TOOL_ID = 'action';
const CREATE_TOOL_ID = 'custom_tool';

const HEADING = '## Tools: search before you say no';
const INTRO =
  'Your tool list is NOT everything you can do: many more tools exist, and you reach them by search.';
/** Without tool search, the intro must not send the agent to it. */
const INTRO_SEARCH_OFF = 'Your tool list is NOT everything Snaglet can do: many more tools exist.';
const REPORT_FAILURE =
  'If a call fails, report the actual error rather than assuming access was lost.';
/** The two incidents in one emphatic rule: unsearched "can't", and "lost access". */
const RULE = `**NEVER declare a capability unavailable before searching the catalog. ${REPORT_FAILURE}**`;
const RULE_SEARCH_OFF = `**${REPORT_FAILURE}**`;

const has = (tools: readonly ResolvedAgentTool[], id: string): boolean =>
  tools.some((at) => at.tool.id === id);

function capabilitiesPath(name: string | null | undefined): string {
  const who = name?.trim() || 'your agent';
  return `Agents → ${who} → Capabilities`;
}

interface Facts {
  helper: boolean;
  gateway: boolean;
  create: boolean;
  capabilities: string;
}

function steps({ helper, gateway, create, capabilities }: Facts): string[] {
  const call = gateway
    ? `\`action({tool: '<id>', params: {...}})\``
    : 'call it by its id as a tool call';
  const blocked = helper
    ? 'say so in your report: it is blocked, not missing.'
    : `tell the user exactly that; they can allow it in ${capabilities}.`;
  const nothingFits = create
    ? `4. **Nothing fits?** Try other words. If a new tool is the right fix, you can create one with \`custom_tool\` (op \`create\`) and call the \`tool_id\` it returns${gateway ? ' with `action`' : ''}; the user may need to approve its code.`
    : helper
      ? '4. **Nothing fits?** Say in your report what tool you would need; do not claim the task is impossible.'
      : `4. **Nothing fits?** Say what tool you would need. The user can add one (Tools view → New tool) or allow \`custom_tool\` in ${capabilities}.`;
  return [
    `1. **Search first.** Need something not in your list? \`tool({op: 'search', query: 'color theme'})\`: name the thing or the verb ("calendar event", "send email").`,
    `2. **Found it? Use it.** \`tool({op: 'schema', name: '<id>'})\` for its parameters (never guess them), then ${call}. Reuse a known tool while its schema remains available; handle access or availability errors explicitly.`,
    `3. **Blocked?** If a result or error says your tool access blocks it, ${blocked}`,
    nothingFits,
  ];
}

function example(gateway: boolean): string {
  const call = gateway
    ? "`action({tool: 'change_color_theme', params: {op: 'set', colors: {detail: '#2f6fed'}}})`"
    : "call `change_color_theme` with `{op: 'set', colors: {detail: '#2f6fed'}}`";
  return [
    'Example: the user asks for a new color theme; no theme tool is in your list.',
    `\`tool({op: 'search', query: 'theme'})\` → \`change_color_theme\`; \`tool({op: 'schema', name: 'change_color_theme'})\` → its params; ${call}.`,
  ].join('\n');
}

function searchOff({ helper, capabilities }: Facts): string {
  const ask = helper
    ? 'say so in your report.'
    : `ask the user to allow \`tool\` in ${capabilities}.`;
  return `You cannot search the tool catalog: tool search (\`tool\`) is off for you. Before you say you can't do something, ${ask}`;
}

// No cache_control here — composeSystemPrompt places the single system
// breakpoint on whichever block renders last.
export const toolDiscoveryBlock: BlockBuilder = async (ctx) => {
  const tools = ctx.agentTools ?? [];
  if (tools.length === 0) return null;
  const facts: Facts = {
    helper: isHelperRun(ctx),
    gateway: has(tools, GATEWAY_TOOL_ID),
    create: has(tools, CREATE_TOOL_ID),
    capabilities: capabilitiesPath(ctx.agent?.name),
  };
  // The heading and intro open the block without a blank line between them.
  const text = has(tools, SEARCH_TOOL_ID)
    ? [`${HEADING}\n${INTRO}\n${steps(facts).join('\n')}`, RULE, example(facts.gateway)]
    : [`${HEADING}\n${INTRO_SEARCH_OFF}`, searchOff(facts), RULE_SEARCH_OFF];
  return { type: 'text', text: text.join('\n\n') };
};

/**
 * The rule again, as one line of the per-turn context tail: the tail comes
 * after the whole history, where an agent deep in a conversation still reads
 * it. Null for a run without tool search (nothing to point at).
 */
export function toolDiscoveryReminder(agentTools: readonly ResolvedAgentTool[]): string | null {
  if (!has(agentTools, SEARCH_TOOL_ID)) return null;
  return `Tools: your list is not everything you can do. Before you say you can't do something or that a tool is missing, search: \`tool({op: 'search', query})\`. Never say you "lost access" to a tool.`;
}
