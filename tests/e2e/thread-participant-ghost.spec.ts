import { test, expect, type APIRequestContext } from '@playwright/test';

// A thread participant references a single member_id (NOT NULL FK -> members),
// and each members row resolves to a real agent or user, so a participant that
// points at no agent (an "empty agent" with a Remove button that does nothing)
// cannot be created. These specs assert that at the API and DB boundaries.
// API-level and deterministic.

const BASE = `http://localhost:${process.env.PORT || 4001}/api`;

// A real agent that exists in whichever workspace this runs against —
// resolved from the roster instead of a hardcoded id (a fresh install seeds
// different agents). Never the permanent ghost system agent.
let REAL_AGENT_ID = '';

async function resolveRealAgentId(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/agents`);
  const body = await res.json().catch(() => null);
  const agents: Array<{ id: string; archived?: boolean }> = body?.data ?? [];
  const candidate = agents.find((a) => !a.archived && a.id !== 'ghost');
  if (!candidate) throw new Error('no non-ghost agent available in this workspace');
  return candidate.id;
}

async function postJson(request: APIRequestContext, path: string, body: unknown) {
  const res = await request.post(`${BASE}${path}`, { data: body });
  return { status: res.status(), json: await res.json().catch(() => null) };
}

test.describe('thread participants never render as empty/unresolvable agents', () => {
  let threadId: string;

  test.beforeAll(async ({ request }) => {
    REAL_AGENT_ID = await resolveRealAgentId(request);
    const created = await postJson(request, '/threads', {
      title: `ghost-participant-spec-${Date.now()}`,
      projectId: null,
    });
    expect(created.status, 'thread create should succeed').toBeLessThan(300);
    threadId = created.json?.data?.id;
    expect(threadId, 'thread id returned').toBeTruthy();

    const added = await postJson(request, `/threads/${threadId}/participants`, {
      agentId: REAL_AGENT_ID,
    });
    expect(added.status, 'add participant should succeed').toBeLessThan(300);
  });

  test.afterAll(async ({ request }) => {
    if (threadId) {
      await request
        .delete(`${BASE}/threads/${threadId}`)
        .catch((err: unknown) => console.warn('thread cleanup failed:', err));
    }
  });

  // No ghost participants: every participant resolves to a real principal.
  test('listed participants all resolve to an agent or user', async ({ request }) => {
    const res = await request.get(`${BASE}/threads/${threadId}/participants`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const participants: Array<{ kind?: string; agentId?: string | null; userId?: string | null }> =
      body?.data ?? [];

    expect(participants.length).toBeGreaterThan(0);

    for (const p of participants) {
      const hasAgent = typeof p.agentId === 'string' && p.agentId.trim().length > 0;
      const hasUser = typeof p.userId === 'string' && p.userId.trim().length > 0;
      expect(
        hasAgent || hasUser,
        `participant must resolve to an agent or user, got ${JSON.stringify(p)}`
      ).toBe(true);
    }

    const ours = participants.find((p) => p.agentId === REAL_AGENT_ID);
    expect(ours, 'added agent participant should be listed').toBeTruthy();
  });

  // Every listed participant is removable; count drops by exactly one.
  test('removing a participant by agentId actually removes it', async ({ request }) => {
    const before = await (await request.get(`${BASE}/threads/${threadId}/participants`)).json();
    const beforeCount: number = (before?.data ?? []).length;
    expect(beforeCount).toBeGreaterThan(0);

    const del = await request.delete(`${BASE}/threads/${threadId}/participants/${REAL_AGENT_ID}`);
    expect(del.status(), 'remove should succeed').toBeLessThan(300);

    const after = await (await request.get(`${BASE}/threads/${threadId}/participants`)).json();
    const afterList: Array<{ agentId?: string | null }> = after?.data ?? [];
    expect(afterList.length, 'count drops by exactly one').toBe(beforeCount - 1);
    expect(
      afterList.some((p) => p.agentId === REAL_AGENT_ID),
      'removed agent must be gone'
    ).toBe(false);
  });

  // A blank agentId remove must not silently succeed.
  test('removing with a blank agentId does not silently no-op', async ({ request }) => {
    await postJson(request, `/threads/${threadId}/participants`, { agentId: REAL_AGENT_ID });

    const before = await (await request.get(`${BASE}/threads/${threadId}/participants`)).json();
    const beforeCount: number = (before?.data ?? []).length;
    expect(beforeCount).toBeGreaterThan(0);

    // Trailing whitespace segment — the shape a blank-principal remove would take.
    const del = await request.delete(`${BASE}/threads/${threadId}/participants/%20`);
    expect(del.status(), 'blank-agentId remove must be a 4xx, not success').toBeGreaterThanOrEqual(
      400
    );
    expect(del.status()).toBeLessThan(500);

    const after = await (await request.get(`${BASE}/threads/${threadId}/participants`)).json();
    const afterList: Array<{ agentId?: string | null }> = after?.data ?? [];
    expect(afterList.length, 'real participant survives the bad remove').toBe(beforeCount);
    expect(afterList.some((p) => p.agentId === REAL_AGENT_ID)).toBe(true);
  });
});

// A ghost participant cannot be created: a participant must reference a
// member_id (NOT NULL FK -> members), and the public add path requires a real
// agent. Both the API and a raw DB insert must refuse to manufacture a ghost.
test.describe('participant ghost — impossible to create', () => {
  let threadId: string;

  test.beforeAll(async ({ request }) => {
    const created = await postJson(request, '/threads', {
      title: `ghost-impossible-${Date.now()}`,
    });
    expect(created.status, 'thread create').toBeLessThan(300);
    threadId = created.json?.data?.id ?? created.json?.id;
    expect(threadId, 'thread id present').toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (threadId)
      await request
        .delete(`${BASE}/threads/${threadId}`)
        .catch((err: unknown) => console.warn('thread cleanup failed:', err));
  });

  test('public add API rejects a blank agentId', async ({ request }) => {
    const res = await postJson(request, `/threads/${threadId}/participants`, { agentId: '   ' });
    expect(res.status, 'blank agentId must be rejected').toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('public add API rejects an unknown agentId', async ({ request }) => {
    const res = await postJson(request, `/threads/${threadId}/participants`, {
      agentId: `nope-${Date.now()}`,
    });
    expect(res.status, 'unknown agent must 404').toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('raw DB insert of a member-less participant is rejected by the schema', async ({
    request,
  }) => {
    // The member_id column is NOT NULL with an FK to members, so the database
    // refuses a principal-less row.
    const seed = await request.post(`${BASE}/db/tables/thread_participants/rows`, {
      data: { thread_id: threadId },
    });
    expect(
      seed.status(),
      'a participant row with no member must be refused at the DB boundary'
    ).toBeGreaterThanOrEqual(400);

    // And the thread still has no ghost.
    const after = await (await request.get(`${BASE}/threads/${threadId}/participants`)).json();
    const participants: Array<unknown> = after?.data ?? [];
    expect(participants.length, 'no ghost participant materialized').toBe(0);
  });
});
