import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { gotoView, openApp } from './helpers/nav';

const PROBE_QUERY = 'codex-channel-probe-zqx';

function searchResponse(mode: string) {
  const title =
    mode === 'semantic'
      ? 'Semantic mode result'
      : mode === 'hybrid'
        ? 'Hybrid mode result'
        : 'Keyword mode result';
  const channels = mode === 'hybrid' ? ['fts', 'vector'] : [mode === 'semantic' ? 'vector' : 'fts'];
  const primary = {
    node_id: `probe-${mode}`,
    kind: 'doc',
    score: 1,
    channels,
    payload: { title, containerId: null, sortOrder: 0 },
  };
  return {
    success: true,
    data: {
      byKind: {
        doc: [primary],
      },
      channelsUsed: channels,
      semanticStatus: 'ready',
      semanticStatusReason: null,
      coverage: {
        doc: mode === 'semantic' ? 'semantic' : mode === 'hybrid' ? 'hybrid' : 'lexical',
      },
      filesystem: [],
      files: [],
    },
  };
}

async function mockSearchModes(page: Page) {
  const requests: Array<{
    query?: string;
    mode?: string;
    settled?: boolean;
    rerankScope?: string;
  }> = [];
  await page.route('**/api/search/palette', async (route: Route) => {
    const body = route.request().postDataJSON() as {
      query?: string;
      mode?: string;
      settled?: boolean;
      rerankScope?: string;
    };
    if (body.query !== PROBE_QUERY) {
      await route.continue();
      return;
    }
    requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(searchResponse(body.mode ?? 'hybrid')),
    });
  });
  return requests;
}

async function clickChannel(scope: Locator, name: 'Keyword' | 'Vector') {
  await scope.getByText(name, { exact: true }).click();
}

test('interactive search stops after keyword and debounced hybrid without reranking', async ({
  page,
}) => {
  const requests = await mockSearchModes(page);
  await openApp(page);

  await page.getByRole('textbox', { name: 'Search workspace tree' }).fill(PROBE_QUERY);

  await expect(page.getByRole('option', { name: /Hybrid mode result/ })).toBeVisible();
  await page.waitForTimeout(800);
  expect(requests.map((request) => request.mode)).toEqual(['keyword', 'hybrid']);
  expect(requests.every((request) => request.settled === undefined)).toBe(true);
  expect(requests.every((request) => request.rerankScope === undefined)).toBe(true);
  await expect(page.getByText(/^Score /)).toHaveCount(0);
});

test('workspace tree search switches between keyword and vector results', async ({ page }) => {
  await mockSearchModes(page);
  await openApp(page);

  const methods = page.getByRole('group', { name: 'Search methods for workspace tree' });
  await expect(methods.getByRole('checkbox', { name: 'Keyword' })).toBeChecked();
  await expect(methods.getByRole('checkbox', { name: 'Vector' })).toBeChecked();

  // Keyword only.
  await clickChannel(methods, 'Vector');
  await page.getByRole('textbox', { name: 'Search workspace tree' }).fill(PROBE_QUERY);
  await expect(page.getByRole('option', { name: /Keyword mode result/ })).toBeVisible();

  // Vector only. The result itself changes, proving this is not decorative UI.
  await clickChannel(methods, 'Vector');
  await clickChannel(methods, 'Keyword');
  await expect(page.getByRole('option', { name: /Semantic mode result/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Keyword mode result/ })).toHaveCount(0);
});

test('Cmd+K uses the same per-query search channel control', async ({ page }) => {
  await mockSearchModes(page);
  await openApp(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');

  const dialog = page.getByRole('dialog', { name: 'Quick search' });
  await expect(dialog).toBeVisible();
  const methods = dialog.getByRole('group', { name: 'Search methods for quick search' });

  await clickChannel(methods, 'Vector');
  await dialog.getByRole('textbox', { name: 'Quick search' }).fill(PROBE_QUERY);
  await expect(dialog.getByRole('option', { name: /Keyword mode result/ })).toBeVisible();

  await clickChannel(methods, 'Vector');
  await clickChannel(methods, 'Keyword');
  await expect(dialog.getByRole('option', { name: /Semantic mode result/ })).toBeVisible();
  await expect(dialog.getByRole('option', { name: /Keyword mode result/ })).toHaveCount(0);
});

test('the search methods group offers only Keyword and Vector', async ({ page }) => {
  await openApp(page);

  const methods = page.getByRole('group', { name: 'Search methods for workspace tree' });
  await expect(methods.getByRole('checkbox')).toHaveCount(2);
  await expect(methods.getByRole('checkbox', { name: 'Keyword' })).toBeChecked();
  await expect(methods.getByRole('checkbox', { name: 'Vector' })).toBeChecked();
});

test('human search keeps expensive evidence lanes off until the query asks for them', async ({
  page,
}) => {
  await openApp(page);
  const input = page.getByRole('textbox', { name: 'Search workspace tree' });
  const responseFor = (query: string, mode: 'keyword' | 'hybrid') =>
    page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/search/palette')) return false;
      const request = response.request();
      const body = request.postDataJSON() as { query?: string; mode?: string };
      return body.query === query && body.mode === mode;
    });

  const genericQuery = 'embeddings';
  const genericResponse = responseFor(genericQuery, 'keyword');
  const genericEnrichment = responseFor(genericQuery, 'hybrid');
  await input.fill(genericQuery);
  const genericBody = (await (await genericResponse).json()) as {
    data: { byKind: Record<string, unknown[]> };
  };
  expect(genericBody.data.byKind.message).toBeUndefined();
  expect(genericBody.data.byKind.thread_summary).toBeUndefined();
  const enrichedBody = (await (await genericEnrichment).json()) as {
    data: { byKind: Record<string, unknown[]> };
  };
  expect(enrichedBody.data.byKind.message).toBeDefined();
  expect(enrichedBody.data.byKind.thread_summary).toBeDefined();

  const evidenceQuery = 'when did we discuss embeddings?';
  const evidenceResponse = responseFor(evidenceQuery, 'keyword');
  await input.fill(evidenceQuery);
  const evidenceBody = (await (await evidenceResponse).json()) as {
    data: { byKind: Record<string, unknown[]> };
  };
  expect(evidenceBody.data.byKind.message).toBeDefined();
  expect(evidenceBody.data.byKind.thread_summary).toBeDefined();
});

// Live-embeddings prerequisite
// The test below needs real embedding
// coverage on the attached workspace so a nonsense query still has nearest
// neighbors by meaning. A workspace whose semantic search is not ready must
// skip it — the behavior is meaningless without embedded content.
const API_BASE = `http://localhost:${process.env.PORT || '4001'}/api`;

async function paletteProbe(query: string, mode: string) {
  const res = await fetch(`${API_BASE}/search/palette`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, settled: true }),
  });
  if (!res.ok) return null;
  return (await res.json()) as {
    data?: { semanticStatus?: string; byKind?: Record<string, Array<{ node_id: string }>> };
  };
}

async function semanticsReady(): Promise<boolean> {
  const body = await paletteProbe('readiness probe', 'hybrid');
  return body?.data?.semanticStatus === 'ready';
}

test('human search lists the closest meaning matches when no words match', async ({ page }) => {
  test.skip(!(await semanticsReady()), 'semantic search not ready on this workspace');
  await openApp(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const dialog = page.getByRole('dialog', { name: 'Quick search' });
  const query = 'zzqv nonexistent sentient banana 92841';
  const enrichment = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/search/palette')) return false;
    const body = response.request().postDataJSON() as { query?: string; mode?: string };
    return body.query === query && body.mode === 'hybrid';
  });

  await dialog.getByRole('textbox', { name: 'Quick search' }).fill(query);
  const body = (await (await enrichment).json()) as {
    data: { byKind: Record<string, Array<{ channels: string[] }>>; files: unknown[] };
  };
  const meaningOnly = Object.values(body.data.byKind)
    .flat()
    .filter((hit) => hit.channels.includes('vector') && !hit.channels.includes('fts'));
  const closest = meaningOnly.length + body.data.files.length;
  expect(closest).toBeGreaterThan(0);
  expect(closest).toBeLessThanOrEqual(5);
  // Result rows only; the "No results" status row is an option too.
  const rows = dialog.locator('[data-result-index]');
  await expect(rows.first()).toBeVisible();
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(closest);
});

// The embeddings maintenance dashboard lives under Settings → Data alongside
// Backups. Both destinations exist; the palette offers no "Open Embeddings
// settings" action.
test('Settings keeps the Embeddings maintenance destination beside database maintenance', async ({
  page,
}) => {
  await gotoView(page, 'Settings');
  await expect(page.getByRole('treeitem', { name: /Embeddings Coverage, backfill/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Backups Snapshots and restore' })).toBeVisible();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const dialog = page.getByRole('dialog', { name: 'Quick search' });
  await expect(dialog.getByRole('button', { name: 'Open Embeddings settings' })).toHaveCount(0);
});
