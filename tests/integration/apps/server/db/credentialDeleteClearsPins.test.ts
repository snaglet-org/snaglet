/**
 * Deleting a provider credential must clear any agent or thread participant
 * that had it pinned, so those actors fall back to the provider primary instead
 * of dangling on a deleted id. There is no FK on agents.credential_id /
 * thread_participants.credential_id, so UserProviderCredentials.delete does the
 * cleanup itself — this pins that contract against a real database.
 */
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, Agents } from '@snaglet/db';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';

const PREFIX = 'cred-delete-it';
const CRED_ID = `${PREFIX}-cred`;
const AGENT_ID = `${PREFIX}-agent`;

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
  await getDb().query(`DELETE FROM public.user_provider_credentials WHERE id = $1`, [CRED_ID]);
}

describe('UserProviderCredentials.delete clears pinned credentials (real DB)', () => {
  afterAll(cleanup);
  beforeEach(cleanup);

  it('nulls an agent pinned to a credential when that credential is deleted', async () => {
    await UserProviderCredentials.create({
      id: CRED_ID,
      providerId: 'openai',
      authTypeId: 'openai:api-key',
      authType: 'api-key',
      label: 'delete-clears-pins fixture',
      encryptedSecret: 'enc',
    });
    await Agents.create({ id: AGENT_ID, name: 'cred-delete-it pinned' });
    await getDb().query(`UPDATE public.agents SET credential_id = $1 WHERE id = $2`, [
      CRED_ID,
      AGENT_ID,
    ]);

    const before = await getDb().query<{ credential_id: string | null }>(
      `SELECT credential_id FROM public.agents WHERE id = $1`,
      [AGENT_ID]
    );
    expect(before.rows[0]?.credential_id).toBe(CRED_ID);

    const deleted = await UserProviderCredentials.delete(CRED_ID);
    expect(deleted).toBe(true);

    const after = await getDb().query<{ credential_id: string | null }>(
      `SELECT credential_id FROM public.agents WHERE id = $1`,
      [AGENT_ID]
    );
    // Falls through to the provider primary instead of dangling on the deleted id.
    expect(after.rows[0]?.credential_id).toBeNull();
  });
});
