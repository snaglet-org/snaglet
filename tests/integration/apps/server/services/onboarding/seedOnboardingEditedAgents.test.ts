/**
 * The onboarding seed never overwrites a starter agent the user already
 * changed: an agent whose Identity or System prompt differs from the text it
 * was created with keeps both fields as they are, while its design doc is
 * still created. Runs against real PostgreSQL on its own database, because the
 * seed runs once per database.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Docs } from '@snaglet/db/tables/docs';
import { TABLES_READER_ROLE } from '@snaglet/db/runtime/postgres/runtime';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = createHash('sha256')
    .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
    .digest('base64url');
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: jest.fn(),
    broadcast: jest.fn(),
    sendToClient: jest.fn(),
  },
}));

import { agentService } from '@server/services/AgentService';
import { seedOnboardingOnce } from '@server/services/onboarding/seedOnboarding';
import { STARTER_AGENTS, starterAgentDefaults } from '@server/services/onboarding/starterAgents';
import type { OnboardingSeedRecord } from '@server/services/settings/categories/onboarding';

const PATTY_PROMPT = 'Answer in one short paragraph.';
const CLIO_PERSONA = 'You are Clio, a cheerful planner who loves lists.';

let record: OnboardingSeedRecord;

function defaults(agentId: 'patty' | 'clio') {
  const starter = STARTER_AGENTS.find((agent) => agent.id === agentId);
  if (!starter) throw new Error(`No starter agent ${agentId}`);
  return starterAgentDefaults(starter);
}

beforeAll(async () => {
  // Reading the roster creates the starter agents, as on a first launch. The
  // user then changes one field of each before the seed runs.
  await agentService.list();
  await agentService.update('patty', { rawSystemPrompt: PATTY_PROMPT });
  await agentService.update('clio', { identity: CLIO_PERSONA });
  const seeded = await seedOnboardingOnce();
  if (!seeded) throw new Error('a fresh database should be seeded');
  record = seeded;
}, 120_000);

describe('seedOnboardingOnce with starter agents the user already changed', () => {
  it('still seeds, design docs included', async () => {
    expect(record.status).toBe('done');
    for (const agentId of ['patty', 'clio']) {
      const designId = record.docs?.[`${agentId}-agent-design`];
      expect(designId).toBeDefined();
      expect(await Docs.findById(designId!)).not.toBeNull();
    }
  });

  it('leaves a changed system prompt and the untouched identity beside it alone', async () => {
    const patty = await agentService.get('patty');
    expect(patty?.rawSystemPrompt).toBe(PATTY_PROMPT);
    expect(patty?.rawIdentity).toBe(defaults('patty').identity);
  });

  it('leaves a changed identity and the untouched system prompt beside it alone', async () => {
    const clio = await agentService.get('clio');
    expect(clio?.rawIdentity).toBe(CLIO_PERSONA);
    expect(clio?.rawSystemPrompt).toBe(defaults('clio').systemPrompt);
  });
});
