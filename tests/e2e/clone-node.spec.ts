import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * Clone / copy-paste coverage at the API layer — the exact endpoint the
 * workspace tree's context menu (Copy / Paste / Duplicate) and the
 * Cmd/Ctrl+C → Cmd/Ctrl+V gesture both call (`cloneApi.clone` → POST
 * /api/clone). Mirrors the API-level style of workspace-tree-api.spec.ts.
 *
 * Verifies the two acceptance behaviors from the clone-UI spec:
 *   - Duplicate a doc beside itself → the copy lands with a `(1)` suffix.
 *   - Paste a container into another container → the whole subtree arrives.
 *
 * Local-only (the e2e harness has `webServer: undefined`): run against a
 * server already up on PORT.
 */
const API = `http://localhost:${process.env.PORT || '4001'}/api`;

let PARENT = '';

async function createContainer(
  request: APIRequestContext,
  name: string,
  parentId: string | null = null
) {
  const r = await request.post(`${API}/containers`, {
    data: parentId ? { name, parentId } : { name },
  });
  expect([200, 201]).toContain(r.status());
  return (await r.json()).data;
}

async function createDoc(
  request: APIRequestContext,
  title: string,
  containerId: string,
  content = '# body'
) {
  const r = await request.post(`${API}/docs`, { data: { title, containerId, content } });
  expect([200, 201]).toContain(r.status());
  return (await r.json()).data;
}

test.beforeAll(async ({ request }) => {
  const parent = await createContainer(request, `clone-spec-parent-${Date.now()}`);
  PARENT = parent.id;
});

test.afterAll(async ({ request }) => {
  // Cascade delete removes every clone created under this parent too.
  if (PARENT) await request.delete(`${API}/containers/${PARENT}`);
});

test.describe('Clone — POST /api/clone', () => {
  test('duplicate a doc beside itself → copy gets a (1) suffix', async ({ request }) => {
    const doc = await createDoc(request, `Notes-${Date.now()}`, PARENT, 'hello body');

    const r = await request.post(`${API}/clone`, {
      data: { sourceId: doc.id, targetContainerId: PARENT },
    });
    expect(r.status()).toBe(201);
    const { data } = await r.json();
    expect(data.count).toBe(1);
    expect(data.root.id).not.toBe(doc.id); // fresh id
    expect(data.root.title).toBe(`${doc.title} (1)`); // collision suffix

    // The copy is a real, readable doc with the source's content.
    const read = await request.get(`${API}/docs/${data.root.id}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).data.content).toBe('hello body');
  });

  test('paste a container into another container → subtree arrives', async ({ request }) => {
    // Source subtree: SRC > child doc.
    const src = await createContainer(request, `Src-${Date.now()}`, PARENT);
    await createDoc(request, 'Child Doc', src.id, 'child body');
    // Destination container.
    const dest = await createContainer(request, `Dest-${Date.now()}`, PARENT);

    const r = await request.post(`${API}/clone`, {
      data: { sourceId: src.id, targetContainerId: dest.id },
    });
    expect(r.status()).toBe(201);
    const { data } = await r.json();
    // SRC + its child doc = 2 nodes cloned.
    expect(data.count).toBe(2);
    expect(data.root.parentId).toBe(dest.id);

    // The cloned container really lives under dest, carrying its child doc.
    const kids = await request.get(`${API}/containers?parentId=${dest.id}`);
    expect(kids.status()).toBe(200);
    const clonedContainer = (await kids.json()).data.find(
      (c: { id: string }) => c.id === data.root.id
    );
    expect(clonedContainer).toBeTruthy();
  });
});
