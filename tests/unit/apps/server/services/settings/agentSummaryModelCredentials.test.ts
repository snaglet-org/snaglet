import { agentSettings } from '@server/services/settings/categories/agent';

describe('agent summary-model settings credential schema', () => {
  it('round-trips credentialId for agent-level overrides', () => {
    const value = {
      clio: {
        providerId: 'codex',
        modelId: 'gpt-5.6-luna',
        credentialId: 'cred-codex-primary',
      },
    };

    expect(agentSettings.summaryModelOverrides.schema.parse(value)).toEqual(value);
  });

  it('round-trips credentialId for thread-agent overrides', () => {
    const value = {
      'thread-1': {
        clio: {
          providerId: 'anthropic',
          modelId: 'claude-sonnet-5',
          credentialId: 'cred-anthropic-primary',
        },
      },
    };

    expect(agentSettings.threadSummaryModelOverrides.schema.parse(value)).toEqual(value);
  });
});
