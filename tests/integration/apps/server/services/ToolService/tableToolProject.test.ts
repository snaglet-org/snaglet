/**
 * Where a table the `table` tool creates lands, through ToolExecutor against
 * real PostgreSQL: a create from a project thread (or a helper thread in a
 * project) puts it in that project and the result says so; a set_project op
 * in the same call wins, to another project or to none; a flat thread and a
 * call with no thread (hooks and SDK code) create it workspace-wide; the
 * default goes through the same live-project check as set_project; and
 * altering an existing table from a project thread never moves it.
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Agents, Containers, Threads, getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));

import { runWithActor } from '@server/realtime/actorContext';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { findResolvedAgentTool } from '@server/services/ToolService/lib/resolveAgentTool';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const AGENT = 'test-agent-a';
const PROJECT = 'container-4444444444444-project1';
const OTHER_PROJECT = 'container-4444444444444-project2';
const ARCHIVED_PROJECT = 'container-4444444444444-project3';
const THREAD_IN_PROJECT = 'thread-4444444444444-aaaaaaaaa';
const HELPER_THREAD = 'thread-4444444444444-bbbbbbbbb';
const THREAD_IN_ARCHIVED = 'thread-4444444444444-ccccccccc';
const THREAD_FLAT = 'thread-4444444444444-fffffffff';

type Result = Awaited<ReturnType<typeof toolExecutor.execute>>;

async function schema(
  context: ToolHandlerContext,
  input: Record<string, unknown>
): Promise<Result> {
  const agentTool = findResolvedAgentTool(await resolveAgentTools(AGENT), 'table');
  if (!agentTool) throw new Error(`${AGENT} has no table tool`);
  return runWithActor({ actorKind: 'agent', actorId: AGENT, actorName: 'Test Agent A' }, () =>
    toolExecutor.execute({ name: 'table', input: { op: 'schema', ...input } }, agentTool, context)
  );
}

/** The first line of a successful call: the heading that says where the table is. */
async function heading(context: ToolHandlerContext, input: Record<string, unknown>) {
  const result = await schema(context, input);
  if (!result.success) throw new Error(`table schema failed: ${result.error}`);
  return result.output.split('\n')[0];
}

async function projectOf(name: string): Promise<string | null | undefined> {
  return (await TableCatalog.findByName(name))?.projectId;
}

const fromThread = (threadId: string): ToolHandlerContext => ({ agentId: AGENT, threadId });
const NOTES = [{ name: 'notes', type: 'text' }];

beforeAll(async () => {
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
  const { rows } = await getDb().query<{ provider_id: string; model_id: string }>(
    `SELECT provider_id, model_id FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      ORDER BY provider_id, sort_order LIMIT 1`
  );
  const model = rows[0];
  if (!model) throw new Error('No active tool-capable model is seeded');
  await Agents.create({
    id: AGENT,
    name: 'Test Agent A',
    providerId: model.provider_id,
    modelId: model.model_id,
  });
  await Containers.create({ id: PROJECT, name: 'Launch', category: 'project' });
  await Containers.create({ id: OTHER_PROJECT, name: 'Sales', category: 'project' });
  await Containers.create({ id: ARCHIVED_PROJECT, name: 'Old launch', category: 'project' });
  await Threads.create({ id: THREAD_IN_PROJECT, title: 'In project', projectId: PROJECT });
  // A helper thread takes its parent's project when it is made (SubagentService).
  await Threads.create({
    id: HELPER_THREAD,
    title: 'Test Agent A › helper',
    projectId: PROJECT,
    parentThreadId: THREAD_IN_PROJECT,
  });
  await Threads.create({
    id: THREAD_IN_ARCHIVED,
    title: 'In an archived project',
    projectId: ARCHIVED_PROJECT,
  });
  await Threads.create({ id: THREAD_FLAT, title: 'Flat' });
  // Only the project is archived, so a run could still call from its thread.
  await getDb().query(
    'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
    [ARCHIVED_PROJECT]
  );
});

describe('table op schema: where a created table lands', () => {
  it('puts a table created from a project thread in that project and says so', async () => {
    expect(
      await heading(fromThread(THREAD_IN_PROJECT), { table: 'launch_tasks', fields: NOTES })
    ).toBe(`created launch_tasks in project Launch (${PROJECT}):`);
    expect(await projectOf('launch_tasks')).toBe(PROJECT);
  });

  it('puts a table created from a helper thread in the helper thread’s project', async () => {
    expect(await heading(fromThread(HELPER_THREAD), { table: 'helper_notes', fields: [] })).toBe(
      `created helper_notes in project Launch (${PROJECT}):`
    );
    expect(await projectOf('helper_notes')).toBe(PROJECT);
  });

  it('lets a set_project op in the same call choose another project', async () => {
    expect(
      await heading(fromThread(THREAD_IN_PROJECT), {
        table: 'sales_leads',
        fields: NOTES,
        ops: [{ op: 'set_project', project_id: OTHER_PROJECT }],
      })
    ).toBe(`created sales_leads in project Sales (${OTHER_PROJECT}):`);
    expect(await projectOf('sales_leads')).toBe(OTHER_PROJECT);
  });

  it('lets set_project null in the same call keep the table workspace-wide', async () => {
    expect(
      await heading(fromThread(THREAD_IN_PROJECT), {
        table: 'shared_glossary',
        fields: NOTES,
        ops: [{ op: 'set_project', project_id: null }],
      })
    ).toBe('created shared_glossary (workspace-wide):');
    expect(await projectOf('shared_glossary')).toBeNull();
  });

  it('creates a table workspace-wide from a thread with no project', async () => {
    expect(await heading(fromThread(THREAD_FLAT), { table: 'flat_notes', fields: NOTES })).toBe(
      'created flat_notes (workspace-wide):'
    );
    expect(await projectOf('flat_notes')).toBeNull();
  });

  it('creates a table workspace-wide when the call has no thread, as hook and SDK calls do', async () => {
    expect(await heading({ agentId: AGENT }, { table: 'script_notes', fields: NOTES })).toBe(
      'created script_notes (workspace-wide):'
    );
    expect(await projectOf('script_notes')).toBeNull();
  });

  it('refuses a default project that is no longer live, and set_project still wins', async () => {
    const refused = await schema(fromThread(THREAD_IN_ARCHIVED), {
      table: 'stale_notes',
      fields: NOTES,
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/error 400: Project .* is archived/);
    expect(await TableCatalog.findByName('stale_notes')).toBeNull();

    expect(
      await heading(fromThread(THREAD_IN_ARCHIVED), {
        table: 'stale_notes',
        fields: NOTES,
        ops: [{ op: 'set_project', project_id: null }],
      })
    ).toBe('created stale_notes (workspace-wide):');
    expect(await projectOf('stale_notes')).toBeNull();
  });

  it('never moves an existing table when it is altered from a project thread', async () => {
    expect(
      await heading(fromThread(THREAD_IN_PROJECT), {
        table: 'flat_notes',
        ops: [{ op: 'add_field', field: { name: 'due', type: 'date' } }],
      })
    ).toBe('altered flat_notes (1 op):');
    expect(await projectOf('flat_notes')).toBeNull();
  });
});
