import { buildModelCandidates } from '@server/services/SocketService/handlers/modelCandidates';

describe('buildModelCandidates', () => {
  it('prioritizes thread override and resolves its credential first', async () => {
    const resolveCredentialIdForModel = jest
      .fn()
      .mockResolvedValueOnce('cred-thread')
      .mockResolvedValueOnce('cred-effective')
      .mockResolvedValueOnce('cred-chain');

    const candidates = await buildModelCandidates({
      threadOverrideModel: {
        provider: 'openai',
        modelId: 'gpt-5',
        credential: 'cred-explicit',
      },
      effectiveModel: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        credentialId: 'cred-effective',
        source: 'agent_default',
      },
      agentModelChain: [
        {
          provider_id: 'openai',
          model_id: 'gpt-4.1',
          credential_id: 'cred-chain',
          priority: 1,
        },
      ],
      agentModel: {
        provider: 'anthropic',
        modelId: 'claude-opus-4',
        credentialId: 'cred-agent',
      },
      resolveCredentialIdForModel,
    });

    expect(resolveCredentialIdForModel).toHaveBeenNthCalledWith(1, {
      providerId: 'openai',
      modelId: 'gpt-5',
      preferredCredentialId: 'cred-explicit',
    });
    expect(resolveCredentialIdForModel).toHaveBeenNthCalledWith(2, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      preferredCredentialId: 'cred-effective',
    });
    expect(resolveCredentialIdForModel).toHaveBeenNthCalledWith(3, {
      providerId: 'openai',
      modelId: 'gpt-4.1',
      preferredCredentialId: 'cred-chain',
    });
    expect(candidates.map((c) => c.source)).toEqual([
      'thread_override',
      'agent_default',
      'agent_model:1',
    ]);
    expect(candidates[0]).toEqual({
      provider_id: 'openai',
      model_id: 'gpt-5',
      credential_id: 'cred-thread',
      source: 'thread_override',
    });
  });

  it('falls back to agent model when no thread/effective/chain model exists', async () => {
    const resolveCredentialIdForModel = jest.fn().mockResolvedValue('cred-agent-resolved');

    const candidates = await buildModelCandidates({
      effectiveModel: null,
      agentModelChain: [],
      agentModel: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        credentialId: 'cred-agent',
      },
      resolveCredentialIdForModel,
    });

    expect(resolveCredentialIdForModel).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      preferredCredentialId: 'cred-agent',
    });
    expect(candidates).toEqual([
      {
        provider_id: 'anthropic',
        model_id: 'claude-sonnet-4-5',
        credential_id: 'cred-agent-resolved',
        source: 'agent',
      },
    ]);
  });

  it('deduplicates identical candidates by provider/model/credential', async () => {
    const resolveCredentialIdForModel = jest.fn().mockResolvedValue('cred-1');

    const candidates = await buildModelCandidates({
      threadOverrideModel: {
        provider: 'openai',
        modelId: 'gpt-5',
        credential: 'cred-explicit',
      },
      effectiveModel: {
        providerId: 'openai',
        modelId: 'gpt-5',
        credentialId: 'cred-1',
        source: 'agent_default',
      },
      agentModelChain: [],
      agentModel: {
        provider: 'openai',
        modelId: 'gpt-5',
        credentialId: 'cred-1',
      },
      resolveCredentialIdForModel,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('thread_override');
  });

  it('resolves missing credentials for effective models before emitting a candidate', async () => {
    const resolveCredentialIdForModel = jest.fn().mockResolvedValue('cred-provider-default');

    const candidates = await buildModelCandidates({
      effectiveModel: {
        providerId: 'codex',
        modelId: 'gpt-5.4',
        credentialId: null,
        source: 'agent_default',
      },
      agentModelChain: [],
      agentModel: {
        provider: 'codex',
        modelId: 'gpt-5.4',
        credentialId: null,
      },
      resolveCredentialIdForModel,
    });

    expect(resolveCredentialIdForModel).toHaveBeenCalledWith({
      providerId: 'codex',
      modelId: 'gpt-5.4',
      preferredCredentialId: null,
    });
    expect(candidates).toEqual([
      {
        provider_id: 'codex',
        model_id: 'gpt-5.4',
        credential_id: 'cred-provider-default',
        source: 'agent_default',
      },
    ]);
  });
});
