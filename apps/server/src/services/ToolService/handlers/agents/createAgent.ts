/**
 * agent(op: create) — create a new agent; optional `skills` (ids or slugs)
 * become its default skills. Built-in skills are not assigned (every agent
 * always has them); the reply names any that were asked for.
 */
import { agentService } from '@server/services/AgentService';
import { invalidateAll as invalidateCache } from '@server/services/ConfigResolverService';
import type { ToolHandler } from '@server/services/ToolService/types';
import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';
import { builtinSkillsNote, builtinSlugs, planSkillChange } from './agentSkills';

interface CreateAgentParams {
  name: string;
  role?: string;
  system_prompt?: string;
  identity?: string;
  provider?: string;
  model_id?: string;
  tool_access_mode?: 'all' | 'allow_list' | 'deny_list';
  skills?: unknown;
}

const handler: ToolHandler = async (input) => {
  const { name, role, system_prompt, identity, provider, model_id, tool_access_mode, skills } =
    input as unknown as CreateAgentParams;

  if (!name || !String(name).trim()) {
    return JSON.stringify({ success: false, error: 'name is required' });
  }
  if (!role || !String(role).trim()) {
    return JSON.stringify({ success: false, error: 'role is required' });
  }

  // Validate skills before the agent exists, so a bad reference creates nothing.
  let skillIds: string[] = [];
  let builtinIgnored: string[] = [];
  if (skills !== undefined) {
    const plan = await planSkillChange({ set_skills: skills });
    if (typeof plan === 'string') return JSON.stringify({ success: false, error: plan });
    skillIds = plan.setIds ?? [];
    builtinIgnored = builtinSlugs(skillIds, plan.registry);
  }

  const agent = await agentService.create({
    name,
    role,
    provider: provider ?? 'anthropic',
    modelId: model_id ?? null,
    credentialId: null,
    identity: identity ?? null,
    rawSystemPrompt: system_prompt ?? null,
    systemPrompt: system_prompt ?? '',
    toolAccessMode: tool_access_mode ?? null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: null,
    toolOverrides: null,
    maxToolCallsPerTurn: null,
    maxDurationSeconds: null,
    fallbacks: null,
    disableModelFallback: false,
  });

  const assigned =
    skillIds.length > 0 ? await SkillAssignmentService.replaceGeneral(agent.id, skillIds) : [];

  await invalidateCache();

  return JSON.stringify({
    success: true,
    agent_id: agent.id,
    name: agent.name,
    role: agent.role ?? undefined,
    ...(assigned.length ? { skill_ids: assigned } : {}),
    ...builtinSkillsNote(builtinIgnored),
    message: `Agent "${agent.name}" created successfully with id ${agent.id}.`,
  });
};

export default handler;
