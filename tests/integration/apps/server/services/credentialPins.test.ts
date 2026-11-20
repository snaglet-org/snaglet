/**
 * Credential pins against a real database — the chain behind a dead
 * hand-pasted Claude Code token:
 *
 *   1. the dead token's row is pinned everywhere (provider primary, agent,
 *      thread model override, agent and thread summary-model overrides);
 *   2. "Sign in with Claude Code" creates a new managed row — which now takes
 *      over every pin of the failed row;
 *   3. deleting the dead row leaves nothing dangling, and the summary model
 *      still resolves, so the thread does not halt.
 *
 * Plus: deleting a pinned credential moves its pins to the remaining one (or
 * clears them when none is left), and a pin that still dangles halts with copy
 * that names the missing credential instead of "no summary model".
 */

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, Threads } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { adoptPinsForClaudeCodeSignIn } from '@server/services/ClaudeCodeAuthService/signInPins';
import { deleteCredentialRepointingPins } from '@server/services/ProviderCredentialService/credentialPins';
import { settingsService } from '@server/services/settings';
import { cache } from '@server/services/settings/cache';
import { agentSettings } from '@server/services/settings/categories/agent';
import {
  haltOnSummaryFailure,
  resetSummaryHaltsForTests,
  summaryHaltRefusal,
  type SummaryHalt,
} from '@server/services/summary/summaryHalt';
import { resolveUtilityModel } from '@server/services/summary/UtilityModelResolver';
import { encrypt } from '@server/utils/encryption';

process.env.CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32);

const PREFIX = 'test-credential-pins';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const SUMMARY_MODEL = 'claude-haiku-4-5';
const CRED_PASTED = `${PREFIX}-pasted`;
const CRED_OTHER = `${PREFIX}-other`;
const CRED_MANAGED = `${PREFIX}-managed`;

async function createCredential(
  id: string,
  over: { label: string; authTypeId?: string; authType?: string; managed?: boolean }
): Promise<void> {
  await UserProviderCredentials.create({
    id,
    providerId: 'anthropic',
    authTypeId: over.authTypeId ?? 'anthropic:claude-code-pro',
    authType: over.authType ?? 'oauth',
    label: over.label,
    encryptedSecret: encrypt(`sk-ant-oat01-${id}`),
    metadataJson: over.managed ? { managed_by: 'claude-code-cli' } : {},
  });
}

async function pinEverythingTo(credentialId: string): Promise<void> {
  const db = getDb();
  await db.query(`UPDATE public.providers SET primary_credential_id = $1 WHERE id = 'anthropic'`, [
    credentialId,
  ]);
  await db.query(`UPDATE public.agents SET credential_id = $1 WHERE id = $2`, [
    credentialId,
    AGENT_ID,
  ]);
  await db.query(
    `UPDATE public.thread_participants SET credential_id = $1
      WHERE thread_id = $2 AND provider_id IS NOT NULL`,
    [credentialId, THREAD_ID]
  );
  const ref = { providerId: 'anthropic', modelId: SUMMARY_MODEL, credentialId };
  await settingsService.write(agentSettings.summaryModelOverrides, { [AGENT_ID]: ref });
  await settingsService.write(agentSettings.threadSummaryModelOverrides, {
    [THREAD_ID]: { [AGENT_ID]: ref },
  });
}

interface PinState {
  primary: string | null;
  agent: string | null;
  participant: string | null;
  summary: string | null | undefined;
  threadSummary: string | null | undefined;
}

async function readPins(): Promise<PinState> {
  const db = getDb();
  cache.__clearForTests();
  const primary = await db.query<{ primary_credential_id: string | null }>(
    `SELECT primary_credential_id FROM public.providers WHERE id = 'anthropic'`
  );
  const agent = await db.query<{ credential_id: string | null }>(
    `SELECT credential_id FROM public.agents WHERE id = $1`,
    [AGENT_ID]
  );
  const participant = await db.query<{ credential_id: string | null }>(
    `SELECT credential_id FROM public.thread_participants
      WHERE thread_id = $1 AND provider_id IS NOT NULL`,
    [THREAD_ID]
  );
  const summary = await settingsService.read(agentSettings.summaryModelOverrides);
  const threadSummary = await settingsService.read(agentSettings.threadSummaryModelOverrides);
  return {
    primary: primary.rows[0]?.primary_credential_id ?? null,
    agent: agent.rows[0]?.credential_id ?? null,
    participant: participant.rows[0]?.credential_id ?? null,
    summary: summary[AGENT_ID]?.credentialId,
    threadSummary: threadSummary[THREAD_ID]?.[AGENT_ID]?.credentialId,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query(`UPDATE public.providers SET primary_credential_id = NULL WHERE id = 'anthropic'`);
  await db.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await db.query(`DELETE FROM public.notifications WHERE thread_id = $1`, [THREAD_ID]);
  await db.query(`DELETE FROM public.thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await db.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await db.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
  await db.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [[THREAD_ID, AGENT_ID]]);
  await db.query(`DELETE FROM public.user_provider_credentials WHERE id LIKE $1`, [`${PREFIX}-%`]);
  await db.query(
    `DELETE FROM public.settings WHERE category = 'agent'
       AND key IN ('summary_model_overrides', 'thread_summary_model_overrides')`
  );
  cache.__clearForTests();
}

describe('credential pins (real DB)', () => {
  beforeEach(async () => {
    await cleanup();
    resetSummaryHaltsForTests();
    await getDb().query(
      `UPDATE public.models SET is_active = true WHERE provider_id = 'anthropic' AND model_id = $1`,
      [SUMMARY_MODEL]
    );
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await Agents.create({
      id: AGENT_ID,
      name: PREFIX,
      providerId: 'anthropic',
      modelId: SUMMARY_MODEL,
    });
    await ThreadParticipants.addParticipant({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      providerId: 'anthropic',
      modelId: SUMMARY_MODEL,
    });
  });

  afterAll(async () => {
    await cleanup();
    resetSummaryHaltsForTests();
  });

  it('sign-in takes over a failed token’s pins; deleting it then halts nothing', async () => {
    await createCredential(CRED_PASTED, { label: 'Pasted Claude Code token' });
    await pinEverythingTo(CRED_PASTED);
    // The pasted token's last call failed authentication.
    await UserProviderCredentials.updateVerificationStatus(CRED_PASTED, 'fail');

    // "Sign in with Claude Code" writes a separate managed row …
    await createCredential(CRED_MANAGED, { label: 'Claude Code login', managed: true });
    const adopted = await adoptPinsForClaudeCodeSignIn(CRED_MANAGED);
    expect(adopted.fromCredentialIds).toEqual([CRED_PASTED]);
    expect(adopted.agentIds).toEqual([AGENT_ID]);

    // … which now holds every pin, including the provider primary.
    expect(await readPins()).toEqual({
      primary: CRED_MANAGED,
      agent: CRED_MANAGED,
      participant: CRED_MANAGED,
      summary: CRED_MANAGED,
      threadSummary: CRED_MANAGED,
    });

    // Deleting the dead row leaves nothing to move and nothing dangling.
    const deleted = await deleteCredentialRepointingPins(CRED_PASTED);
    expect(deleted?.repointed.agentIds).toEqual([]);

    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    expect(resolution).toMatchObject({
      ok: true,
      model: { providerId: 'anthropic', modelId: SUMMARY_MODEL, credentialId: CRED_MANAGED },
    });
  });

  it('deleting a pinned credential re-points every pin to the remaining credential', async () => {
    await createCredential(CRED_PASTED, { label: 'Test key A' });
    await createCredential(CRED_OTHER, { label: 'Test key B' });
    await pinEverythingTo(CRED_PASTED);

    const result = await deleteCredentialRepointingPins(CRED_PASTED);

    expect(result).toMatchObject({
      deleted: { id: CRED_PASTED, providerId: 'anthropic' },
      repointed: {
        toCredential: { id: CRED_OTHER, label: 'Test key B' },
        providerPrimary: true,
        agentIds: [AGENT_ID],
        threadParticipantThreadIds: [THREAD_ID],
        summaryOverrideAgentIds: [AGENT_ID],
        threadSummaryOverrides: [{ threadId: THREAD_ID, agentId: AGENT_ID }],
      },
    });
    expect(await readPins()).toEqual({
      primary: CRED_OTHER,
      agent: CRED_OTHER,
      participant: CRED_OTHER,
      summary: CRED_OTHER,
      threadSummary: CRED_OTHER,
    });
    await expect(UserProviderCredentials.findById(CRED_PASTED)).resolves.toBeNull();

    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    expect(resolution).toMatchObject({ ok: true, model: { credentialId: CRED_OTHER } });
  });

  it('prefers the provider primary over a newer remaining credential', async () => {
    await createCredential(CRED_OTHER, { label: 'Test key B' });
    await createCredential(CRED_MANAGED, { label: 'Test key C' });
    await createCredential(CRED_PASTED, { label: 'Test key A' });
    await pinEverythingTo(CRED_PASTED);
    await getDb().query(
      `UPDATE public.providers SET primary_credential_id = $1 WHERE id = 'anthropic'`,
      [CRED_OTHER]
    );

    const result = await deleteCredentialRepointingPins(CRED_PASTED);
    expect(result?.repointed.toCredential?.id).toBe(CRED_OTHER);
    expect(result?.repointed.providerPrimary).toBe(false);
    expect((await readPins()).agent).toBe(CRED_OTHER);
  });

  it('clears the pins when the provider has no credential left', async () => {
    await createCredential(CRED_PASTED, { label: 'Test key A' });
    await pinEverythingTo(CRED_PASTED);

    const result = await deleteCredentialRepointingPins(CRED_PASTED);

    expect(result?.repointed.toCredential).toBeNull();
    expect(await readPins()).toEqual({
      primary: null,
      agent: null,
      participant: null,
      summary: null,
      threadSummary: null,
    });
  });

  it('returns null for an unknown credential and changes nothing', async () => {
    await expect(deleteCredentialRepointingPins(`${PREFIX}-missing`)).resolves.toBeNull();
  });

  it('a pin that still dangles halts with copy naming the missing credential', async () => {
    const missing = `${PREFIX}-deleted-elsewhere`;
    await settingsService.write(agentSettings.threadSummaryModelOverrides, {
      [THREAD_ID]: {
        [AGENT_ID]: { providerId: 'anthropic', modelId: SUMMARY_MODEL, credentialId: missing },
      },
    });

    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    expect(resolution).toMatchObject({ ok: false, reason: 'no-credentials' });
    if (resolution.ok) throw new Error('expected a failed resolution');

    const halt = await haltOnSummaryFailure(
      { status: 'skipped', reason: resolution.reason, detail: resolution.detail },
      { threadId: THREAD_ID, agentId: AGENT_ID, agentName: PREFIX }
    );
    expect(halt).not.toBeNull();
    const refusal = summaryHaltRefusal(halt as SummaryHalt);
    expect(refusal).toContain(missing);
    expect(refusal).toContain('anthropic');
    expect(refusal).not.toContain('no summary model is available');
  });
});
