import { describe, it, expect } from '@jest/globals';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import { registry } from '@server/services/settings/registry';
import { agentSettings } from '@server/services/settings/categories/agent';

describe('agent.global_instructions setting', () => {
  const def = agentSettings.globalInstructions;

  it('is registered under the agent category and defaults to empty', () => {
    expect(def.key).toBe('global_instructions');
    expect(def.default).toBe('');
    expect(registry.get('agent', 'global_instructions')).toBe(def);
  });

  it('accepts text up to the cap and rejects longer text or non-strings', () => {
    expect(def.schema.safeParse('Keep replies short.').success).toBe(true);
    expect(def.schema.safeParse('x'.repeat(AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH)).success).toBe(
      true
    );
    expect(def.schema.safeParse('x'.repeat(AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH + 1)).success).toBe(
      false
    );
    expect(def.schema.safeParse(42).success).toBe(false);
    expect(def.schema.safeParse(null).success).toBe(false);
  });
});
