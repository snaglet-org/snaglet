import { test, expect } from '@playwright/test';

// API-level coverage for surfaces 1-4; mirrors the pattern in agent-identity.spec.ts.
// API base matches helpers/chat.ts.
const API = `http://localhost:${process.env.PORT || '4001'}/api`;

// Real parent container, created fresh in this database before any test runs
// (a hardcoded ID would only exist in one particular DB and 404 elsewhere).
let KNOWN_PARENT = '';
let KNOWN_DOC = '';

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${API}/containers`, {
    data: { name: `probe-fixture-parent-${Date.now()}` },
  });
  if (r.status() !== 201 && r.status() !== 200) {
    throw new Error(`fixture parent create failed: HTTP ${r.status()} ${await r.text()}`);
  }
  const json = await r.json();
  KNOWN_PARENT = json.data?.id ?? json.id;
  if (!KNOWN_PARENT) throw new Error(`fixture parent has no id: ${JSON.stringify(json)}`);

  const dr = await request.post(`${API}/docs`, {
    data: {
      title: `probe-fixture-doc-${Date.now()}`,
      containerId: KNOWN_PARENT,
      content: '# fixture',
    },
  });
  if (dr.status() !== 201 && dr.status() !== 200) {
    throw new Error(`fixture doc create failed: HTTP ${dr.status()} ${await dr.text()}`);
  }
  const djson = await dr.json();
  KNOWN_DOC = djson.data?.id ?? djson.id;
  if (!KNOWN_DOC) throw new Error(`fixture doc has no id: ${JSON.stringify(djson)}`);
});

test.describe('Surface 1 — Workspace tree (API)', () => {
  test('GET /api/containers returns a list', async ({ request }) => {
    const r = await request.get(`${API}/containers`);
    expect(r.status()).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });
});

test.describe('Surface 2 — Containers (API)', () => {
  let createdId: string | null = null;

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await request.delete(`${API}/containers/${createdId}`);
      createdId = null;
    }
  });

  test('create -> read -> delete container', async ({ request }) => {
    const name = `clio-spec-${Date.now()}`;
    const create = await request.post(`${API}/containers`, {
      data: { name, parentId: KNOWN_PARENT },
    });
    // Server returns 201 Created for POST. Accept 200 or 201 to be tolerant.
    expect([200, 201]).toContain(create.status());
    const created = (await create.json()).data;
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);
    expect(created.parentId).toBe(KNOWN_PARENT);
    createdId = created.id;

    const read = await request.get(`${API}/containers/${created.id}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).data.id).toBe(created.id);
  });

  test('create with missing name returns 400 validation error (not 500)', async ({ request }) => {
    const r = await request.post(`${API}/containers`, {
      data: { parentId: KNOWN_PARENT },
    });
    expect(r.status()).toBe(400);
    const json = await r.json();
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  test('create with non-existent parent should NOT leak a stack trace', async ({ request }) => {
    const r = await request.post(`${API}/containers`, {
      data: { name: `clio-bad-parent-${Date.now()}`, parentId: 'container-does-not-exist-xyz' },
    });
    const body = await r.text();
    // Should be a clean 4xx, not a 500 with internals.
    expect(
      r.status(),
      `expected clean 4xx, got ${r.status()} body=${body.slice(0, 200)}`
    ).toBeLessThan(500);
    expect(body).not.toContain('at NodesRepository');
    expect(body).not.toContain('PostgresError');
  });
});

test.describe('Surface 3 — Documents (API)', () => {
  test('GET /api/docs/:id works on a known doc', async ({ request }) => {
    // Doc fixture created fresh in this DB by beforeAll (was a hardcoded foreign ID).
    const r = await request.get(`${API}/docs/${KNOWN_DOC}`);
    expect(r.status()).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(KNOWN_DOC);
  });

  test('GET /api/docs (list) — current behavior probe', async ({ request }) => {
    // Containers and threads both expose a list endpoint;
    // /api/docs returns 404. This test pins current behavior so a future
    // fix flips it from 404 -> 200 visibly.
    const r = await request.get(`${API}/docs`);
    expect(r.status()).toBe(404);
  });
});

test.describe('Surface 4 — Threads & routing (API)', () => {
  let createdId: string | null = null;

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await request.delete(`${API}/threads/${createdId}`);
      createdId = null;
    }
  });

  test('GET /api/threads returns a list', async ({ request }) => {
    const r = await request.get(`${API}/threads`);
    expect(r.status()).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });

  test('thread create with unknown parent_id field silently orphans (current behavior)', async ({
    request,
  }) => {
    // The server accepts the unknown field and creates a flat thread
    // (projectId: null). Strict validation should reject unknown fields.
    // Pin current behavior; flip to expect 400 once fixed.
    const r = await request.post(`${API}/threads`, {
      data: { title: `clio-orphan-probe-${Date.now()}`, parent_id: KNOWN_PARENT },
    });
    expect([200, 201]).toContain(r.status());
    const created = (await r.json()).data;
    createdId = created.id;
    expect(created.projectId).toBeNull();
  });

  test('thread create with nonexistent project_id should not leak a stack trace', async ({
    request,
  }) => {
    // Parallel to the container FK-leak bug: does the threads route
    // validate project_id, or does it 500 with Postgres internals?
    const r = await request.post(`${API}/threads`, {
      data: {
        title: `clio-bad-project-${Date.now()}`,
        project_id: 'container-does-not-exist-xyz',
      },
    });
    const body = await r.text();
    expect(
      r.status(),
      `expected clean 4xx, got ${r.status()} body=${body.slice(0, 200)}`
    ).toBeLessThan(500);
    expect(body).not.toContain('PostgresError');
    expect(body).not.toContain('at NodesRepository');
    // If a thread was actually created, register for cleanup so we don't
    // leak orphans across test runs.
    try {
      const json = JSON.parse(body);
      if (json?.data?.id) createdId = json.data.id;
    } catch {
      // Non-JSON body — nothing to register for cleanup.
      console.debug('workspace-tree-api: response body was not JSON');
    }
  });

  test('PATCH dispatch_mode rejects invalid value (validation lives)', async ({ request }) => {
    // Create a clean flat thread, then try to set an invalid dispatch_mode.
    const create = await request.post(`${API}/threads`, {
      data: { title: `clio-dispatch-${Date.now()}`, project_id: null },
    });
    expect([200, 201]).toContain(create.status());
    const t = (await create.json()).data;
    createdId = t.id;

    const bad = await request.patch(`${API}/threads/${t.id}`, {
      data: { dispatch_mode: 'shout-into-the-void' },
    });
    // Should be 400 — bad value, not silently accepted.
    expect(bad.status()).toBe(400);
    const j = await bad.json();
    expect(j.success).toBe(false);
  });
});

// Surface 3 (extended) — Documents CRUD lifecycle
// Full create/read/update/delete plus the FK-leak parallel test.
test.describe('Surface 3 (extended) — Documents CRUD', () => {
  let createdId: string | null = null;

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await request.delete(`${API}/docs/${createdId}`);
      createdId = null;
    }
  });

  test('create -> read -> patch -> delete doc', async ({ request }) => {
    const title = `clio-doc-${Date.now()}`;
    const create = await request.post(`${API}/docs`, {
      data: { title, containerId: KNOWN_PARENT, content: '# hello' },
    });
    expect([200, 201]).toContain(create.status());
    const created = (await create.json()).data;
    expect(created.id).toBeTruthy();
    expect(created.title).toBe(title);
    createdId = created.id;

    const read = await request.get(`${API}/docs/${created.id}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).data.id).toBe(created.id);

    const patch = await request.patch(`${API}/docs/${created.id}`, {
      data: { title: `${title}-renamed` },
    });
    expect(patch.status()).toBe(200);
    const reread = await request.get(`${API}/docs/${created.id}`);
    expect((await reread.json()).data.title).toBe(`${title}-renamed`);
  });

  test('doc create with nonexistent containerId should NOT leak a stack trace', async ({
    request,
  }) => {
    const r = await request.post(`${API}/docs`, {
      data: {
        title: `clio-doc-bad-container-${Date.now()}`,
        containerId: 'container-does-not-exist-xyz',
        content: 'x',
      },
    });
    const body = await r.text();
    expect(
      r.status(),
      `expected clean 4xx, got ${r.status()} body=${body.slice(0, 200)}`
    ).toBeLessThan(500);
    expect(body).not.toContain('PostgresError');
    expect(body).not.toContain('at NodesRepository');
    try {
      const json = JSON.parse(body);
      if (json?.data?.id) createdId = json.data.id;
    } catch {
      // Non-JSON body — nothing to register for cleanup.
      console.debug('workspace-tree-api: response body was not JSON');
    }
  });

  test('doc create with missing title returns 400 (not 500)', async ({ request }) => {
    const r = await request.post(`${API}/docs`, {
      data: { containerId: KNOWN_PARENT, content: 'no title' },
    });
    expect(r.status()).toBe(400);
  });
});
