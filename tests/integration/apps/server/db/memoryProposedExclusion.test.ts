/**
 * Memory verified/status columns at the SQL level: `status = 'proposed'` rows
 * never come back from Memories.hybridSearch for either owner kind; a create
 * that omits the columns lands as verified=false / status='active'; and
 * through memoryService.store a member-scoped proposal is inert until an
 * explicit re-save of the same key makes it active, verified and recallable.
 *
 * Who sees what: an agent's recall in a thread with one human also searches
 * that person's kept (active) facts, in one pool; the `search` tool returns
 * the calling agent's own memories plus those kept facts and nothing else
 * (never a proposal, never another agent's, nothing without a calling agent);
 * the palette (a person) sees every active memory but never a proposal.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Agents, Members, Memories, Threads } from '@snaglet/db';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Users } from '@snaglet/db/tables/users';
import { memoryService } from '@server/services/MemoryService';
import { searchPaletteOnlyKind } from '@server/services/search/paletteSearchQueries';
import searchTool from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';

const PREFIX = 'mem-proposed-test';
const AGENT_ID = `agent-${PREFIX}`;
const OTHER_AGENT_ID = `agent-${PREFIX}-other`;
const THREAD_ID = `thread-${PREFIX}`;
const SCOPE_IDS = {
  own: `memory-${PREFIX}-quokka-own`,
  kept: `memory-${PREFIX}-quokka-kept`,
  proposed: `memory-${PREFIX}-quokka-proposed`,
  theirs: `memory-${PREFIX}-quokka-theirs`,
};

async function search(
  input: Record<string, unknown>,
  context: Record<string, unknown>
): Promise<string> {
  const out = await (
    searchTool as unknown as (i: unknown, s: unknown, c: unknown) => Promise<unknown>
  )(input, {}, context);
  return typeof out === 'string' ? out : JSON.stringify(out);
}

let userId: string;
let memberId: string;

describe('memory proposed-status exclusion (real DB)', () => {
  beforeAll(async () => {
    await Agents.create({ id: AGENT_ID, name: `${PREFIX} agent` });
    const user = await Users.upsertUser({
      email: `${PREFIX}@test.local`,
      name: `${PREFIX} user`,
      authProvider: 'test',
      authProviderId: `${PREFIX}-auth`,
    });
    userId = user.id;
    const member = await Members.findByUser(userId);
    if (!member) throw new Error('Expected member row for test user');
    memberId = member.id;

    // A thread whose one human is the test user, and four memories made in it
    // that all match "quokka": the agent's own, a fact about the user they
    // kept, one still proposed, and another agent's.
    await Agents.create({ id: OTHER_AGENT_ID, name: `${PREFIX} other agent` });
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await ThreadParticipants.addUserParticipant({ threadId: THREAD_ID, userId });
    await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
    await Memories.create({
      id: SCOPE_IDS.own,
      agentId: AGENT_ID,
      key: 'quokka-own',
      content: 'The quokka exporter writes nightly.',
      sourceThreadId: THREAD_ID,
    });
    await Memories.create({
      id: SCOPE_IDS.kept,
      memberId,
      key: 'quokka-kept',
      content: 'Test User keeps a quokka sticker on the laptop.',
      sourceThreadId: THREAD_ID,
      verified: true,
      status: 'active',
    });
    await Memories.create({
      id: SCOPE_IDS.proposed,
      memberId,
      key: 'quokka-proposed',
      content: 'Test User might like quokka themed dashboards.',
      sourceThreadId: THREAD_ID,
      verified: false,
      status: 'proposed',
    });
    await Memories.create({
      id: SCOPE_IDS.theirs,
      agentId: OTHER_AGENT_ID,
      key: 'quokka-theirs',
      content: 'Another agent noted the quokka exporter config.',
      sourceThreadId: THREAD_ID,
    });
  });

  afterAll(async () => {
    const pool = getDb();
    await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [THREAD_ID]);
    // Cascades member rows and their owned memories.
    await pool.query(`DELETE FROM public.agents WHERE id = ANY($1)`, [[AGENT_ID, OTHER_AGENT_ID]]);
    await pool.query(`DELETE FROM public.users WHERE id = $1`, [userId]);
  });

  it('create defaults land as verified=false / status=active and round-trip', async () => {
    const row = await Memories.create({
      id: `memory-${PREFIX}-defaults`,
      agentId: AGENT_ID,
      key: 'defaults-probe',
      content: 'Row created without mentioning the 0078 columns.',
    });

    expect(row.verified).toBe(false);
    expect(row.status).toBe('active');

    const reread = await Memories.findById(row.id);
    expect(reread?.verified).toBe(false);
    expect(reread?.status).toBe('active');
  });

  it('hybridSearch (keyword arm) never returns proposed rows — member owner', async () => {
    await Memories.create({
      id: `memory-${PREFIX}-m-active`,
      memberId,
      key: 'approved-narwhal',
      content: 'Test User confirmed the narwhal migration plan.',
      verified: true,
      status: 'active',
    });
    await Memories.create({
      id: `memory-${PREFIX}-m-proposed`,
      memberId,
      key: 'proposed-narwhal',
      content: 'Test User allegedly prefers narwhal migration snapshots.',
      verified: false,
      status: 'proposed',
    });

    const rows = await Memories.hybridSearch(
      null,
      'narwhal migration',
      { memberId },
      { limit: 10 }
    );

    expect(rows.map((row) => row.key)).toContain('approved-narwhal');
    expect(rows.map((row) => row.key)).not.toContain('proposed-narwhal');
    for (const row of rows) expect(row.status).toBe('active');
  });

  it('hybridSearch (keyword arm) never returns proposed rows — agent owner', async () => {
    await Memories.create({
      id: `memory-${PREFIX}-a-active`,
      agentId: AGENT_ID,
      key: 'pangolin-active',
      content: 'The pangolin ledger lives on the shared socket.',
      verified: false,
      status: 'active',
    });
    await Memories.create({
      id: `memory-${PREFIX}-a-proposed`,
      agentId: AGENT_ID,
      key: 'pangolin-proposed',
      content: 'The pangolin ledger might move next quarter.',
      verified: false,
      status: 'proposed',
    });

    const rows = await Memories.hybridSearch(
      null,
      'pangolin ledger',
      { agentId: AGENT_ID },
      { limit: 10 }
    );

    expect(rows.map((row) => row.key)).toContain('pangolin-active');
    expect(rows.map((row) => row.key)).not.toContain('pangolin-proposed');
  });

  it('proposal lifecycle: inert until an explicit re-save of the key promotes it', async () => {
    // Extraction-style proposal about the member.
    await memoryService.store({
      memberId,
      key: 'lifecycle-wombat',
      content: 'Test User reportedly likes wombat dashboards.',
      verified: false,
      status: 'proposed',
    });

    const pending = await Memories.findByKey({ memberId }, 'lifecycle-wombat');
    expect(pending?.status).toBe('proposed');
    expect(pending?.verified).toBe(false);

    // Inert: recall over the same words finds nothing.
    const before = await Memories.hybridSearch(
      null,
      'wombat dashboards',
      { memberId },
      { limit: 10 }
    );
    expect(before.map((row) => row.key)).not.toContain('lifecycle-wombat');

    // Explicit save of the same key by the owner is the approval.
    await memoryService.store({
      memberId,
      key: 'lifecycle-wombat',
      content: 'Test User likes wombat dashboards.',
    });

    const approved = await Memories.findByKey({ memberId }, 'lifecycle-wombat');
    expect(approved?.id).toBe(pending?.id);
    expect(approved?.status).toBe('active');
    expect(approved?.verified).toBe(true);

    const after = await Memories.hybridSearch(
      null,
      'wombat dashboards',
      { memberId },
      { limit: 10 }
    );
    expect(after.map((row) => row.key)).toContain('lifecycle-wombat');
  });

  it('a proposal never overwrites an approved memory with the same key (real SQL)', async () => {
    await memoryService.store({
      memberId,
      key: 'axolotl-ruling',
      content: 'Test User ruled axolotl naming is final.',
    });

    const result = await memoryService.store({
      memberId,
      key: 'axolotl-ruling',
      content: 'Test User might revisit axolotl naming.',
      verified: false,
      status: 'proposed',
    });

    expect(result.isDuplicate).toBe(true);
    const row = await Memories.findByKey({ memberId }, 'axolotl-ruling');
    expect(row?.content).toBe('Test User ruled axolotl naming is final.');
    expect(row?.status).toBe('active');
    expect(row?.verified).toBe(true);
  });
  it("recall with alsoMemberId: the agent's own plus the person's kept facts, one pool", async () => {
    const rows = await memoryService.recall({
      agentId: AGENT_ID,
      alsoMemberId: memberId,
      query: 'quokka',
      limit: 10,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([SCOPE_IDS.own, SCOPE_IDS.kept]));
    expect(ids).not.toContain(SCOPE_IDS.proposed);
    expect(ids).not.toContain(SCOPE_IDS.theirs);
    for (const row of rows) expect(row.status).toBe('active');
    const kept = rows.find((row) => row.id === SCOPE_IDS.kept);
    expect(kept).toMatchObject({ agentId: null, memberId });
  });

  it('recall without alsoMemberId stays the agent alone', async () => {
    const rows = await Memories.hybridSearch(null, 'quokka', { agentId: AGENT_ID }, { limit: 10 });
    expect(rows.map((row) => row.id)).toEqual([SCOPE_IDS.own]);
  });

  it("search tool (keyword): the caller's own and the person's kept facts, nothing else", async () => {
    const out = await search(
      { query: 'quokka', kinds: ['memory'], mode: 'keyword' },
      { agentId: AGENT_ID, threadId: THREAD_ID }
    );
    expect(out).toContain(SCOPE_IDS.own);
    expect(out).toContain(SCOPE_IDS.kept);
    expect(out).not.toContain(SCOPE_IDS.proposed);
    expect(out).not.toContain(SCOPE_IDS.theirs);
  });

  it('search tool (default hybrid): the same rule through the semantic lane', async () => {
    const out = await search(
      { query: 'quokka', kinds: ['memory'] },
      { agentId: AGENT_ID, threadId: THREAD_ID }
    );
    expect(out).toContain(SCOPE_IDS.own);
    expect(out).not.toContain(SCOPE_IDS.proposed);
    expect(out).not.toContain(SCOPE_IDS.theirs);
  });

  it('search tool (fuzzy fallback on a typo): the same rule', async () => {
    const out = await search(
      { query: 'quokkka', kinds: ['memory'], mode: 'keyword' },
      { agentId: AGENT_ID, threadId: THREAD_ID }
    );
    expect(out).toContain(SCOPE_IDS.own);
    expect(out).not.toContain(SCOPE_IDS.proposed);
    expect(out).not.toContain(SCOPE_IDS.theirs);
  });

  it("another agent searching sees its own, not this agent's", async () => {
    const out = await search(
      { query: 'quokka', kinds: ['memory'], mode: 'keyword' },
      { agentId: OTHER_AGENT_ID }
    );
    expect(out).toContain(SCOPE_IDS.theirs);
    expect(out).not.toContain(SCOPE_IDS.own);
    // No thread, so no person's facts either.
    expect(out).not.toContain(SCOPE_IDS.kept);
    expect(out).not.toContain(SCOPE_IDS.proposed);
  });

  it('search tool with no calling agent returns no memories at all', async () => {
    const out = await search({ query: 'quokka', kinds: ['memory'], mode: 'keyword' }, {});
    for (const id of Object.values(SCOPE_IDS)) expect(out).not.toContain(id);
  });

  describe('search tool by exact id: the same rule, and out of scope reads as missing', () => {
    const inThread = { agentId: AGENT_ID, threadId: THREAD_ID };
    const notFound = (id: string) => `No node found for id "${id}".`;

    it("another agent's memory by id → not found, exactly like a missing node", async () => {
      expect(await search({ id: SCOPE_IDS.theirs }, inThread)).toBe(notFound(SCOPE_IDS.theirs));
      const missing = `memory-${PREFIX}-does-not-exist`;
      expect(await search({ id: missing }, inThread)).toBe(notFound(missing));
    });

    it('a proposal by id → not found', async () => {
      expect(await search({ id: SCOPE_IDS.proposed }, inThread)).toBe(notFound(SCOPE_IDS.proposed));
    });

    it('own memory by id → found', async () => {
      const out = await search({ id: SCOPE_IDS.own }, inThread);
      expect(out).toContain(`Resolved id "${SCOPE_IDS.own}" → memory`);
      expect(out).toContain('The quokka exporter writes nightly.');
    });

    it("the thread human's kept fact by id, from the thread's agent → found", async () => {
      const out = await search({ id: SCOPE_IDS.kept }, inThread);
      expect(out).toContain(`Resolved id "${SCOPE_IDS.kept}" → memory`);
      expect(out).toContain('quokka sticker');
    });

    it('no calling agent: even a real memory id → not found', async () => {
      expect(await search({ id: SCOPE_IDS.own }, {})).toBe(notFound(SCOPE_IDS.own));
    });

    it('an id passed as the query never shows an out-of-scope memory', async () => {
      const out = await search({ query: SCOPE_IDS.theirs }, inThread);
      expect(out).not.toContain('Another agent noted the quokka exporter config.');
      expect(out).not.toContain(`Resolved id "${SCOPE_IDS.theirs}"`);
    });

    it('a ranged read by id: out of scope → not found; own → its lines', async () => {
      const range = { start_line: 1, end_line: 1 };
      const theirs = await search({ id: SCOPE_IDS.theirs, content_range: range }, inThread);
      expect(theirs).toContain(notFound(SCOPE_IDS.theirs));
      expect(theirs).not.toContain('Another agent noted');
      const proposed = await search({ id: SCOPE_IDS.proposed, content_range: range }, inThread);
      expect(proposed).toContain(notFound(SCOPE_IDS.proposed));
      const own = await search({ id: SCOPE_IDS.own, content_range: range }, inThread);
      expect(own).toContain('The quokka exporter writes nightly.');
    });
  });

  it('palette (a person): every active memory, never a proposal', async () => {
    const hits = await searchPaletteOnlyKind({ query: 'quokka', kind: 'memory', limit: 20 });
    const ids = hits.map((hit) => hit.node_id);
    expect(ids).toEqual(expect.arrayContaining([SCOPE_IDS.own, SCOPE_IDS.kept, SCOPE_IDS.theirs]));
    expect(ids).not.toContain(SCOPE_IDS.proposed);
  });
});
