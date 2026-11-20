/**
 * workspace_instructions end to end, against PostgreSQL: a new agent asks a
 * person before `set` (and not before `get`), and through the real dispatch
 * and ToolExecutor a denied `set` writes nothing while an approved one
 * replaces the instructions for all agents. A scripted agent (scenarioHarness)
 * calls `set` once and then replies "done".
 */
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Agents } from '@snaglet/db/tables/agents';
import { Settings } from '@snaglet/db/tables/settings';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { resolveToolConfirmation } from '@server/services/SocketService/confirmation';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { withGuardedConfirmationDefaults } from '@server/services/ToolService/lib/guardedTools';
import {
  createScenario,
  pinConversationCompaction,
  pinEmbeddingsUnavailable,
  waitFor,
  type Scenario,
} from '../SocketService/waveScenarios/scenarioHarness';

const TOOL = 'workspace_instructions';
const BEFORE = 'Keep answers short.';
const AFTER = 'Keep answers short.\nUse metric units.';

pinConversationCompaction();
pinEmbeddingsUnavailable();

beforeAll(async () => {
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
});

let scenarios: Scenario[] = [];
afterEach(async () => {
  for (const scenario of scenarios) await scenario.cleanup();
  scenarios = [];
});

async function saved(): Promise<unknown> {
  return (await Settings.read('agent', 'global_instructions'))?.value ?? '';
}

/** An agent with a new agent's guarded defaults that calls set once, then replies. */
async function settingAgentThread(prefix: string): Promise<Scenario> {
  const scenario = await createScenario({
    prefix,
    agents: [
      {
        key: 'host',
        script: [
          { toolCalls: [{ name: TOOL, input: { op: 'set', text: AFTER } }] },
          { reply: 'done' },
        ],
      },
    ],
  });
  await Agents.update(scenario.ids.host!, {
    toolAccessAllowList: [TOOL],
    toolOverrides: await withGuardedConfirmationDefaults(null),
  });
  scenarios.push(scenario);
  return scenario;
}

const confirmationRequests = (scenario: Scenario) =>
  scenario.events.filter((e) => e.type === 'socket:tool:confirmation_request');
const toolResults = (scenario: Scenario) =>
  scenario.events.filter((e) => e.type === 'socket:tool:result');

async function decide(scenario: Scenario, decision: 'approve_once' | 'deny'): Promise<void> {
  await Settings.write('agent', 'global_instructions', BEFORE, {});
  const sending = scenario.send(`@${scenario.names.host} add metric units`);
  await waitFor(() => confirmationRequests(scenario).length === 1, {
    timeoutMs: 30_000,
    label: 'confirmation prompt',
  });
  const [request] = confirmationRequests(scenario);
  // The person sees the exact new text before deciding.
  expect(request!.payload).toMatchObject({ toolName: TOOL });
  expect(request!.payload['inputSummary']).toBe(
    `${JSON.stringify({ op: 'set' }, null, 2)}\n\ntext (${AFTER.length} characters, in full):\n${AFTER}`
  );
  await resolveToolConfirmation(scenario.threadId, String(request!.payload['callId']), decision);
  await sending;
}

describe('workspace_instructions asks a person before it writes', () => {
  it('a new agent confirms set, not get', async () => {
    // What agent creation gives every new agent (AgentService.create, the seed).
    expect((await withGuardedConfirmationDefaults(null))[TOOL]).toEqual({
      requiresConfirmation: true,
    });
    const scenario = await settingAgentThread('wsinstrflags');
    const tools = await resolveAgentTools(scenario.ids.host!);
    expect(tools.find((entry) => entry.tool.id === TOOL)?.opConfirmation).toEqual({
      get: false,
      set: true,
    });
  });

  it('a denied set writes nothing', async () => {
    const scenario = await settingAgentThread('wsinstrdeny');
    await decide(scenario, 'deny');
    expect(await saved()).toBe(BEFORE);
    expect(toolResults(scenario)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ success: false }) }),
    ]);
  }, 60_000);

  it('an approved set replaces the text and returns the previous one', async () => {
    const scenario = await settingAgentThread('wsinstrapprove');
    await decide(scenario, 'approve_once');
    expect(await saved()).toBe(AFTER);
    const [result] = toolResults(scenario);
    expect(result!.payload).toMatchObject({ success: true });
    expect(JSON.parse(String(result!.payload['output']))).toMatchObject({
      saved: true,
      previous: BEFORE,
    });
  }, 60_000);
});
