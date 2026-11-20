/**
 * Subagent helpers inherit their orchestrator's tool permissions live,
 * against the real database and tool catalog: access (allow list), per-tool
 * confirmation overrides and trust come from the orchestrator at resolution
 * time, a helper's `tools` limit only narrows, a grant on a helper's prompt
 * lands where the gap is, and `subagent` never needs an allow-list entry.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: async () => ({ ok: true, reason: 'dispatched', wakeCount: 1, capHit: false }),
}));

import { Agents, SkillAssignments, Threads, ThreadParticipants, getDb } from '@snaglet/db';
import { SUBAGENT_DENIED_TOOL_IDS } from '@snaglet/shared/constants';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { subagentService } from '@server/services/subagents/SubagentService';
import {
  grantHelperTool,
  resolveHelperToolPolicy,
} from '@server/services/subagents/helperInheritance';

const ORCH = 'test-agent-a';
const PARENT = 'thread-1111111111111-inheritaa';

let providerId = '';
let model = '';

async function toolIds(agentId: string): Promise<string[]> {
  return (await resolveAgentTools(agentId)).map((t) => t.tool.id);
}

async function allowList(agentId: string): Promise<string[]> {
  return (await Agents.findById(agentId))?.toolAccessAllowList ?? [];
}

beforeAll(async () => {
  await toolRegistry.load();
  await toolRegistry.syncToDatabase();
  const { rows } = await getDb().query<{ provider_id: string; model_id: string }>(
    `SELECT provider_id, model_id FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      ORDER BY provider_id, sort_order LIMIT 1`
  );
  providerId = rows[0]!.provider_id;
  model = rows[0]!.model_id;
  await Agents.create({
    id: ORCH,
    name: 'Test Agent A',
    providerId,
    modelId: model,
    toolAccessMode: 'allow_list',
    toolAccessAllowList: ['search', 'doc'],
    toolOverrides: { doc: { requiresConfirmation: true } },
  });
  await Threads.create({ id: PARENT, title: 'Parent' });
  await ThreadParticipants.addParticipant({ threadId: PARENT, agentId: ORCH });
});

afterAll(() => {
  subagentService.shutdown();
});

describe('helper permission inheritance (real DB)', () => {
  let open: string;
  let narrowed: string;

  it('a new helper stores only its narrowing; the orchestrator policy applies live', async () => {
    open = (
      await subagentService.start({
        orchestratorAgentId: ORCH,
        parentThreadId: PARENT,
        name: 'Open',
        model,
        brief: 'Look around.',
      })
    ).agentId;
    narrowed = (
      await subagentService.start({
        orchestratorAgentId: ORCH,
        parentThreadId: PARENT,
        name: 'Narrow',
        model,
        brief: 'Search only.',
        tools: ['search'],
      })
    ).agentId;

    expect(await Agents.findById(open)).toMatchObject({
      toolAccessMode: null,
      toolOverrides: null,
      trustedToolCalls: false,
    });
    expect(await Agents.findById(narrowed)).toMatchObject({
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['search'],
    });

    const ids = await toolIds(open);
    expect(ids).toEqual(expect.arrayContaining(['search', 'doc']));
    for (const denied of SUBAGENT_DENIED_TOOL_IDS) expect(ids).not.toContain(denied);
    // The orchestrator's confirmation override reaches the helper.
    const doc = (await resolveAgentTools(open)).find((t) => t.tool.id === 'doc');
    expect(doc?.requiresConfirmation).toBe(true);

    const narrowIds = await toolIds(narrowed);
    expect(narrowIds).toContain('search');
    expect(narrowIds).not.toContain('doc');
  });

  it('copies an orchestrator trust setting when starting a helper', async () => {
    await Agents.update(ORCH, { trustedToolCalls: true });
    const trustedHelper = await subagentService.start({
      orchestratorAgentId: ORCH,
      parentThreadId: PARENT,
      name: 'Trusted helper',
      model,
      brief: 'Use inherited trust.',
    });

    expect(await Agents.findById(trustedHelper.agentId)).toMatchObject({
      trustedToolCalls: true,
    });
    await Agents.update(ORCH, { trustedToolCalls: false });
  });

  it('a permission granted to the orchestrator later reaches its running helpers', async () => {
    expect(await toolIds(open)).not.toContain('web_fetch');
    await Agents.appendToolAccessAllowList(ORCH, 'web_fetch');
    expect(await toolIds(open)).toContain('web_fetch');
    // A helper narrowed to search stays narrowed.
    expect(await toolIds(narrowed)).not.toContain('web_fetch');

    await getDb().query(`UPDATE public.agents SET trusted_tool_calls = true WHERE id = $1`, [ORCH]);
    const doc = (await resolveAgentTools(open)).find((t) => t.tool.id === 'doc');
    expect(doc?.requiresConfirmation).toBe(false);
  });

  it('a grant on a helper prompt lands where the gap is', async () => {
    // The orchestrator lacks `file`: "Always allow" grants it to the
    // orchestrator, and the narrowed helper gets it on its own list too.
    const narrowPolicy = (await resolveHelperToolPolicy(narrowed))!;
    await grantHelperTool(narrowPolicy, narrowed, 'file', 'allow_agent');
    expect(await allowList(ORCH)).toContain('file');
    expect(await allowList(narrowed)).toEqual(expect.arrayContaining(['search', 'file']));
    expect(await toolIds(open)).toContain('file');

    // The orchestrator already has `doc`: a thread grant widens only the
    // helper and never turns the orchestrator's thread entry into an allow list.
    const before = (await ThreadParticipants.listByThread(PARENT)).map((p) => p.toolAccessMode);
    await grantHelperTool(
      (await resolveHelperToolPolicy(narrowed))!,
      narrowed,
      'doc',
      'allow_thread'
    );
    expect(await allowList(narrowed)).toContain('doc');
    expect((await ThreadParticipants.listByThread(PARENT)).map((p) => p.toolAccessMode)).toEqual(
      before
    );
  });

  it('subagent needs no allow-list entry, and a helper never gets it', async () => {
    expect(await allowList(ORCH)).not.toContain('subagent');
    expect(await toolIds(ORCH)).toContain('subagent');
    expect(await toolIds(open)).not.toContain('subagent');
  });

  it('a helper copies the orchestrator’s assigned skills, not a leftover built-in row', async () => {
    const db = getDb();
    for (const [id, scope] of [
      ['skill-inherit-mine', 'personal'],
      ['skill-inherit-snaglet-x', 'builtin'],
    ]) {
      await db.query(
        `INSERT INTO public.skill_registry (id, scope, slug, source_path, status)
         VALUES ($1, $2, $3, $4, 'valid')`,
        [id, scope, id.replace(/^skill-/, ''), `/x/${id}/SKILL.md`]
      );
    }
    // Assigned before built-ins became unassignable: the raw row is still there.
    await SkillAssignments.replace(ORCH, null, ['skill-inherit-snaglet-x', 'skill-inherit-mine']);
    try {
      const helper = await subagentService.start({
        orchestratorAgentId: ORCH,
        parentThreadId: PARENT,
        name: 'Skilled',
        model,
        brief: 'Use the skills.',
      });
      const rows = await SkillAssignments.listForAgent(helper.agentId, null);
      expect(rows.map((r) => r.skillId)).toEqual(['skill-inherit-mine']);
    } finally {
      await db.query(`DELETE FROM public.skill_registry WHERE id LIKE 'skill-inherit-%'`);
    }
  });
});
