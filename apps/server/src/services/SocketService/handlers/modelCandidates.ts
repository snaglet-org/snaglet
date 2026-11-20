export interface ModelCandidate {
  provider_id: string;
  model_id: string;
  credential_id: string | null;
  source: string;
}

interface EffectiveModelCandidate {
  providerId: string;
  modelId: string;
  credentialId: string | null;
  source: string;
}

interface AgentModelCandidate {
  provider_id: string;
  model_id: string;
  credential_id: string | null;
  priority: number;
}

interface ThreadOverrideModelCandidate {
  provider: string;
  modelId: string;
  credential?: string;
}

export interface BuildModelCandidatesInput {
  threadOverrideModel?: ThreadOverrideModelCandidate;
  effectiveModel: EffectiveModelCandidate | null;
  agentModelChain: AgentModelCandidate[];
  agentModel: {
    provider: string | null | undefined;
    modelId: string | null | undefined;
    credentialId: string | null | undefined;
  };
  resolveCredentialIdForModel: (input: {
    providerId: string;
    modelId: string;
    preferredCredentialId?: string | null;
  }) => Promise<string | null>;
}

export async function buildModelCandidates(
  input: BuildModelCandidatesInput
): Promise<ModelCandidate[]> {
  const modelCandidates: ModelCandidate[] = [];
  const seenModelCandidates = new Set<string>();

  const addModelCandidate = async (
    providerId: string | null | undefined,
    modelId: string | null | undefined,
    credentialId: string | null | undefined,
    source: string
  ) => {
    if (!providerId || !modelId) return;
    const resolvedCredentialId = await input
      .resolveCredentialIdForModel({
        providerId,
        modelId,
        preferredCredentialId: credentialId ?? null,
      })
      .catch(() => credentialId ?? null);

    const key = `${providerId}:${modelId}:${resolvedCredentialId ?? ''}`;
    if (seenModelCandidates.has(key)) return;
    seenModelCandidates.add(key);
    modelCandidates.push({
      provider_id: providerId,
      model_id: modelId,
      credential_id: resolvedCredentialId ?? null,
      source,
    });
  };

  if (input.threadOverrideModel) {
    await addModelCandidate(
      input.threadOverrideModel.provider,
      input.threadOverrideModel.modelId,
      input.threadOverrideModel.credential ?? null,
      'thread_override'
    );
  }

  if (input.effectiveModel) {
    await addModelCandidate(
      input.effectiveModel.providerId,
      input.effectiveModel.modelId,
      input.effectiveModel.credentialId,
      input.effectiveModel.source
    );
  }

  for (const entry of input.agentModelChain) {
    await addModelCandidate(
      entry.provider_id,
      entry.model_id,
      entry.credential_id,
      `agent_model:${entry.priority}`
    );
  }

  if (modelCandidates.length === 0) {
    await addModelCandidate(
      input.agentModel.provider,
      input.agentModel.modelId,
      input.agentModel.credentialId,
      'agent'
    );
  }

  return modelCandidates;
}
