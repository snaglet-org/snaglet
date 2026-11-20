import { getErrorMessage } from '@snaglet/shared/utils';
import { agentService } from '@server/services/AgentService';
import { invalidateAll as invalidateCache } from '@server/services/ConfigResolverService';
import type { ToolHandler } from '@server/services/ToolService/types';
import type { SnagletAgentUpdate } from '@server/services/AgentService';
import { HELPER_ROW_EDIT_REFUSAL } from '@server/services/subagents/subagentText';
import {
  applySkillChange,
  builtinSkillsNote,
  hasSkillChange,
  type SkillChangeResult,
} from './agentSkills';

interface UpdateAgentParams {
  agent_id: string;
  name?: string;
  role?: string;
  system_prompt?: string;
  identity?: string;
  model_id?: string;
  provider?: string;
  tool_access_mode?: 'all' | 'allow_list' | 'deny_list';
  add_skills?: unknown;
  remove_skills?: unknown;
  set_skills?: unknown;
}

const handler: ToolHandler = async (input, _settings, context) => {
  const params = input as unknown as UpdateAgentParams;
  const { agent_id, name, role, system_prompt, identity, model_id, provider, tool_access_mode } =
    params;
  const wantsSkills = hasSkillChange(params);

  const agentId = (agent_id ?? '').trim();
  if (!agentId) {
    return JSON.stringify({ success: false, error: 'agent_id is required' });
  }

  const existing = await agentService.get(agentId);
  if (!existing) {
    return JSON.stringify({ success: false, error: `No agent found with id '${agentId}'` });
  }
  // A subagent helper's row (its Snaglet helper prompt, name, model, access) is not
  // an agent's to edit; a call with no agent behind it (or a person borrowing
  // one, act_as) is a person, who may.
  if (existing.parentAgentId && context?.agentId && !context.bypassToolAccess) {
    return JSON.stringify({ success: false, error: HELPER_ROW_EDIT_REFUSAL });
  }

  const patch: SnagletAgentUpdate = {};
  if (name !== undefined) patch.name = name;
  if (role !== undefined) patch.role = role;
  if (system_prompt !== undefined) patch.systemPrompt = system_prompt;
  if (identity !== undefined) patch.identity = identity;
  if (model_id !== undefined) patch.modelId = model_id;
  if (provider !== undefined) patch.provider = provider;
  if (tool_access_mode !== undefined) patch.toolAccessMode = tool_access_mode;

  if (Object.keys(patch).length === 0 && !wantsSkills) {
    return JSON.stringify({
      success: false,
      error:
        'No fields to update. Provide at least one of: name, role, system_prompt, identity, model_id, provider, tool_access_mode, add_skills, remove_skills, set_skills',
    });
  }

  // Skills first: a bad skill reference fails the call before any agent field
  // is written, so the update is never half-applied.
  let skills: SkillChangeResult | undefined;
  if (wantsSkills) {
    try {
      const result = await applySkillChange(agentId, params);
      if (typeof result === 'string') return JSON.stringify({ success: false, error: result });
      skills = result;
    } catch (err) {
      return JSON.stringify({ success: false, error: getErrorMessage(err) });
    }
  }

  let updated: Awaited<ReturnType<typeof agentService.update>> = existing;
  if (Object.keys(patch).length > 0) {
    try {
      updated = await agentService.update(agentId, patch);
    } catch (err) {
      // Rename conflicts and reserved/invalid names come back as a tool result
      // the model can act on.
      return JSON.stringify({ success: false, error: getErrorMessage(err) });
    }
    if (!updated) {
      return JSON.stringify({ success: false, error: `Update failed for agent '${agentId}'` });
    }
  }

  await invalidateCache();

  const updatedFields = [...Object.keys(patch), ...(skills ? ['skills'] : [])];
  return JSON.stringify({
    success: true,
    agent_id: updated.id,
    name: updated.name,
    role: updated.role ?? undefined,
    tool_access_mode: updated.toolAccessMode ?? null,
    updated_fields: updatedFields,
    ...(skills ? { skills: skills.afterLabels } : {}),
    ...builtinSkillsNote(skills?.builtinIgnored ?? []),
    message: `Agent "${updated.name}" updated successfully (${updatedFields.join(', ')}).`,
  });
};

export default handler;
