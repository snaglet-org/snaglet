/** Real PostgreSQL coverage of model resolution: complete tuples replace,
 * empty participant overrides inherit, and partial overrides never blend
 * providers/models/credentials from different levels. */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Agents, Members, ThreadParticipants, Threads, getDb } from '@snaglet/db';

const PREFIX = 'i6';
const THREAD = `thread-${PREFIX}-main`;
const AGENT = `agent-${PREFIX}-actor`;

// Two credentials on two different providers. The pairing between them is the
// whole point: it is what makes a provider/credential mismatch observable
// rather than theoretical.
const CRED_ON_ANTHROPIC = `cred-${PREFIX}-anthropic`;
const CRED_ON_OPENAI = `cred-${PREFIX}-openai`;
const PROVIDER_ANTHROPIC = `prov-${PREFIX}-anthropic`;
const PROVIDER_OPENAI = `prov-${PREFIX}-openai`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = $1`, [THREAD]);
  await pool.query(`DELETE FROM members WHERE agent_id = $1`, [AGENT]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT]);
  await pool.query(`DELETE FROM nodes WHERE id = $1`, [THREAD]);
  await pool.query(`DELETE FROM user_provider_credentials WHERE id = ANY($1::text[])`, [
    [CRED_ON_ANTHROPIC, CRED_ON_OPENAI],
  ]);
}

async function seedCredential(id: string, providerId: string): Promise<void> {
  await getDb().query(
    `INSERT INTO user_provider_credentials (id, provider_id, auth_type, label, encrypted_secret)
     VALUES ($1, $2, 'api_key', $1, 'not-a-real-secret')
     ON CONFLICT (id) DO UPDATE SET provider_id = EXCLUDED.provider_id`,
    [id, providerId]
  );
}

/** The provider a credential actually belongs to, per its own row. */
async function providerOfCredential(credentialId: string): Promise<string> {
  const { rows } = await getDb().query<{ provider_id: string }>(
    `SELECT provider_id FROM user_provider_credentials WHERE id = $1`,
    [credentialId]
  );
  return rows[0]!.provider_id;
}

/** Create the agent with whatever defaults this case needs. */
async function seedAgent(input: {
  providerId?: string | null;
  modelId?: string | null;
  credentialId?: string | null;
}): Promise<void> {
  await Agents.create({
    id: AGENT,
    name: `${PREFIX}-actor`,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    credentialId: input.credentialId ?? null,
  });
}

/** Add the agent to the thread with an optional partial override. */
async function seedParticipant(input: {
  providerId?: string | null;
  modelId?: string | null;
  credentialId?: string | null;
}): Promise<void> {
  await Members.ensureForAgent(AGENT);
  await ThreadParticipants.addParticipant({
    threadId: THREAD,
    agentId: AGENT,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    credentialId: input.credentialId ?? null,
  });
}

beforeEach(async () => {
  await cleanup();
  await seedCredential(CRED_ON_ANTHROPIC, PROVIDER_ANTHROPIC);
  await seedCredential(CRED_ON_OPENAI, PROVIDER_OPENAI);
  await Threads.create({ id: THREAD, title: `${PREFIX} thread` });
});

describe('Threads.getEffectiveModel', () => {
  // Nested inside the describe on purpose: a file-level afterAll runs after the
  // shared database teardown has already closed the pool.
  afterAll(cleanup);

  describe('participant override complete (provider + model)', () => {
    it('the participant wins outright, carrying its own credential', async () => {
      await seedAgent({
        providerId: PROVIDER_OPENAI,
        modelId: 'agent-model',
        credentialId: CRED_ON_OPENAI,
      });
      await seedParticipant({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'participant-model',
        credentialId: CRED_ON_ANTHROPIC,
      });

      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toEqual({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'participant-model',
        credentialId: CRED_ON_ANTHROPIC,
        source: 'thread_participant',
      });
    });

    it('provider, model and credential all come from the same level', async () => {
      await seedAgent({ providerId: PROVIDER_OPENAI, modelId: 'agent-model' });
      await seedParticipant({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'participant-model',
        credentialId: CRED_ON_ANTHROPIC,
      });

      const effective = await Threads.getEffectiveModel(THREAD, AGENT);
      expect(await providerOfCredential(effective!.credentialId!)).toBe(effective!.providerId);
    });
  });

  describe('agent fully configured, no participant row at all', () => {
    it('uses the configured agent tuple when there is no participant', async () => {
      await seedAgent({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'agent-model',
        credentialId: CRED_ON_ANTHROPIC,
      });

      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toEqual({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'agent-model',
        credentialId: CRED_ON_ANTHROPIC,
        source: 'agent',
      });
    });
  });

  describe('agent fully configured, participant row present but empty', () => {
    it('inherits the configured agent tuple with an empty override', async () => {
      await seedAgent({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'agent-model',
        credentialId: CRED_ON_ANTHROPIC,
      });
      await seedParticipant({});

      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toEqual({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'agent-model',
        credentialId: CRED_ON_ANTHROPIC,
        source: 'agent',
      });
    });
  });

  it('resolves a legacy agent provider from its selected credential', async () => {
    await seedAgent({ modelId: 'agent-model', credentialId: CRED_ON_ANTHROPIC });
    await seedParticipant({});
    expect(await Threads.getEffectiveModel(THREAD, AGENT)).toEqual({
      providerId: PROVIDER_ANTHROPIC,
      modelId: 'agent-model',
      credentialId: CRED_ON_ANTHROPIC,
      source: 'agent',
    });
  });

  it('does not guess a provider from a model name alone', async () => {
    await seedAgent({ modelId: 'agent-model' });
    await seedParticipant({});
    expect(await Threads.getEffectiveModel(THREAD, AGENT)).toBeNull();
  });

  describe('participant supplies provider only, agent supplies model', () => {
    // The cross-product case: nobody configured "PROVIDER_ANTHROPIC running
    // agent-model". The participant has a provider and the agent a model, so a
    // blending cascade would invent the pair.
    beforeEach(async () => {
      await seedAgent({
        providerId: PROVIDER_OPENAI,
        modelId: 'agent-model',
        credentialId: CRED_ON_OPENAI,
      });
      await seedParticipant({ providerId: PROVIDER_ANTHROPIC });
    });

    it('rejects a partial override instead of inventing a cross-provider tuple', async () => {
      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toBeNull();
    });
  });

  it.each([{ modelId: 'partial-model' }, { credentialId: CRED_ON_OPENAI }])(
    'does not silently ignore partial override %j',
    async (override) => {
      await seedAgent({
        providerId: PROVIDER_ANTHROPIC,
        modelId: 'agent-model',
        credentialId: CRED_ON_ANTHROPIC,
      });
      await seedParticipant(override);
      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toBeNull();
    }
  );

  describe('nothing resolvable', () => {
    it('returns null when neither level supplies a model', async () => {
      await seedAgent({ providerId: PROVIDER_ANTHROPIC });
      await seedParticipant({ providerId: PROVIDER_ANTHROPIC });

      expect(await Threads.getEffectiveModel(THREAD, AGENT)).toBeNull();
    });

    it('returns null for an agent that does not exist', async () => {
      expect(await Threads.getEffectiveModel(THREAD, `agent-${PREFIX}-missing`)).toBeNull();
    });
  });
});
