import { expect, test, type Locator, type Page } from '@playwright/test';
import { ScratchServer } from './helpers/scratchServer';
import { openApp } from './helpers/nav';

interface ImageDto {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
}

interface ApiResponse<T> {
  success: true;
  data: T;
}

interface PaletteResponse {
  success: true;
  data: {
    byKind: {
      image?: Array<{
        node_id: string;
        payload: { name?: string; description?: string | null; tags?: string[] };
      }>;
    };
    channelsUsed: string[];
  };
}

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function jsonRequest<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function search(server: ScratchServer, query: string): Promise<PaletteResponse> {
  return jsonRequest<PaletteResponse>(`${server.api}/search/palette`, 'POST', {
    query,
    kinds: ['image'],
    mode: 'keyword',
    perKindLimit: 6,
  });
}

async function proxyPaletteToScratch(
  page: Page,
  scratch: ScratchServer,
  requests: Array<Record<string, unknown>> = []
): Promise<void> {
  await page.route(/\/api\/search\/palette(?:\?.*)?$/, async (route) => {
    const request = route.request();
    requests.push(request.postDataJSON() as Record<string, unknown>);
    const upstream = await fetch(`${scratch.api}/search/palette`, {
      method: request.method(),
      headers: { 'Content-Type': 'application/json' },
      body: request.postData(),
    });
    await route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json',
      body: await upstream.text(),
    });
  });
}

async function openHookCodeEditor(page: Page): Promise<Locator> {
  await openApp(page);
  await page.getByRole('tab', { name: /^Automations\b/ }).click();
  await page.getByRole('button', { name: 'New automation or script', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New script', exact: true }).click();
  // The New-hook panel surfaces the code editor directly; a Code tab exists
  // only in the multi-tab builder layout. Click it when present (same
  // convention as hook-editor-mention-search.spec.ts).
  const codeTab = page.getByRole('tab', { name: 'Code', exact: true });
  if (await codeTab.isVisible().catch(() => false)) await codeTab.click();
  const editor = page.getByRole('textbox', { name: 'hook.ts observer code' });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  return editor;
}

async function replaceEditorText(editor: Locator, text: string): Promise<void> {
  await editor.focus();
  await editor.press('Meta+A');
  await editor.press('Backspace');
  await editor.pressSequentially(text, { delay: 15 });
}

test.describe('image metadata keyword lifecycle', () => {
  let server: ScratchServer;

  test.beforeAll(async () => {
    server = await ScratchServer.boot({
      env: { SNAGLET_LOCAL_INTELLIGENCE: 'false', RUN_BACKGROUND_WORKERS: 'false' },
    });
  });

  test.afterAll(async () => {
    await server?.dispose();
  });

  test('replaces and clears description/tags in real keyword search', async () => {
    const suffix = Date.now().toString(36);
    const oldTag = `shoreline-${suffix}`;
    const newTag = `tideline-${suffix}`;
    const oldDescriptionToken = `coastalphrase${suffix}`;
    const newDescriptionToken = `revisedphrase${suffix}`;
    const created = await jsonRequest<ApiResponse<ImageDto>>(`${server.api}/images`, 'POST', {
      name: `neutral-capture-${suffix}.png`,
      dataUrl: PNG_DATA_URL,
      description: `A quiet ${oldDescriptionToken} reference`,
      tags: [oldTag],
    });
    const imageId = created.data.id;

    const initial = await search(server, oldTag);
    const initialHit = initial.data.byKind.image?.find((hit) => hit.node_id === imageId);
    expect(initialHit?.payload).toMatchObject({
      description: `A quiet ${oldDescriptionToken} reference`,
      tags: [oldTag],
    });
    expect(initial.data.channelsUsed).toContain('fts');
    expect(initial.data.channelsUsed).not.toContain('vector');
    expect(
      (await search(server, oldDescriptionToken)).data.byKind.image?.map((hit) => hit.node_id)
    ).toContain(imageId);

    const updated = await jsonRequest<ApiResponse<ImageDto>>(
      `${server.api}/images/${imageId}`,
      'PATCH',
      {
        description: `A ${newDescriptionToken} reference`,
        tags: [` ${newTag} `, newTag, ''],
      }
    );
    expect(updated.data).toMatchObject({
      description: `A ${newDescriptionToken} reference`,
      tags: [newTag],
    });
    expect(
      (await search(server, oldTag)).data.byKind.image?.map((hit) => hit.node_id)
    ).not.toContain(imageId);
    expect(
      (await search(server, oldDescriptionToken)).data.byKind.image?.map((hit) => hit.node_id)
    ).not.toContain(imageId);
    expect((await search(server, newTag)).data.byKind.image?.map((hit) => hit.node_id)).toContain(
      imageId
    );
    expect(
      (await search(server, newDescriptionToken)).data.byKind.image?.map((hit) => hit.node_id)
    ).toContain(imageId);

    await jsonRequest<ApiResponse<ImageDto>>(`${server.api}/images/${imageId}`, 'PATCH', {
      description: null,
      tags: [],
    });
    expect(
      (await search(server, newTag)).data.byKind.image?.map((hit) => hit.node_id)
    ).not.toContain(imageId);
    expect(
      (await search(server, newDescriptionToken)).data.byKind.image?.map((hit) => hit.node_id)
    ).not.toContain(imageId);

    const invalid = await fetch(`${server.api}/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: 'not-an-array' }),
    });
    expect(invalid.status).toBe(400);

    const nonStringTag = await fetch(`${server.api}/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['valid', 42] }),
    });
    expect(nonStringTag.status).toBe(400);

    const overlongTag = await fetch(`${server.api}/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['x'.repeat(61)] }),
    });
    expect(overlongTag.status).toBe(400);

    const combined = await fetch(`${server.api}/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: null, tags: ['combined-write'] }),
    });
    expect(combined.status).toBe(400);
  });

  test('filters and renders real image metadata in Cmd+K', async ({ page }) => {
    const suffix = Date.now().toString(36);
    const descriptionToken = `browserimagephrase${suffix}`;
    const name = `browser-search-${suffix}.png`;
    const created = await jsonRequest<ApiResponse<ImageDto>>(`${server.api}/images`, 'POST', {
      name,
      dataUrl: PNG_DATA_URL,
      description: `A ${descriptionToken} visual reference`,
      tags: ['browser-evidence'],
    });

    // Keep the browser on the protected main UI, but proxy the palette call
    // to the isolated scratch server. This renders a real server/DB result
    // without adding any test image or row to the user's live workspace.
    const requests: Array<Record<string, unknown>> = [];
    await proxyPaletteToScratch(page, server, requests);
    // The image pane fetches its metadata (and bytes) from the images API —
    // proxy those reads to the scratch server too, or the opened pane would
    // 404 on an image that only exists in the isolated workspace.
    await page.route(/\/api\/images\/[^/?]+(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        await route.fallback();
        return;
      }
      const url = new URL(request.url());
      const upstream = await fetch(`${server.baseUrl}${url.pathname}${url.search}`);
      await route.fulfill({
        status: upstream.status,
        contentType: upstream.headers.get('content-type') ?? 'application/json',
        body: Buffer.from(await upstream.arrayBuffer()),
      });
    });

    await openApp(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const dialog = page.getByRole('dialog', { name: 'Quick search' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Target the prefix CHIP (a button) explicitly: once proxied results
    // render, option rows also carry an 'image:' kind badge, and a bare
    // getByText can land on an option and open it instead of applying the
    // filter (closing the palette under the next step).
    await dialog.getByRole('button', { name: 'image:', exact: true }).click();
    await page.getByRole('textbox', { name: 'Quick search' }).fill(descriptionToken);
    const option = dialog.getByRole('option', { name: new RegExp(name) }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(option).toContainText(`A ${descriptionToken} visual reference`);
    await expect(option).toContainText('Tags: browser-evidence');
    await option.click();
    await expect(dialog).toBeHidden();
    // Properties disclosures always mount collapsed now (useDisclosure) —
    // expand before asserting the metadata fields inside the body.
    const properties = page.getByRole('button', { name: 'Properties' });
    await expect(properties).toBeVisible();
    if ((await properties.getAttribute('aria-expanded')) !== 'true') {
      await properties.click();
    }
    await expect(
      page.getByText(`A ${descriptionToken} visual reference`, { exact: true })
    ).toBeVisible();
    await expect(page.getByText('browser-evidence', { exact: true })).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.query === descriptionToken &&
          Array.isArray(request.kinds) &&
          request.kinds.length === 1 &&
          request.kinds[0] === 'image'
      )
    ).toBe(true);
    expect(created.data.id).toBeTruthy();
  });

  test('filters and renders real image metadata in workspace search', async ({ page }) => {
    const suffix = Date.now().toString(36);
    const tag = `tree-image-${suffix}`;
    const name = `tree-search-${suffix}.png`;
    const description = `Workspace tree visual ${suffix}`;
    await jsonRequest<ApiResponse<ImageDto>>(`${server.api}/images`, 'POST', {
      name,
      dataUrl: PNG_DATA_URL,
      description,
      tags: [tag],
    });
    const requests: Array<Record<string, unknown>> = [];
    await proxyPaletteToScratch(page, server, requests);

    await openApp(page);
    const input = page.getByRole('textbox', { name: 'Search workspace tree' });
    await input.fill(`image:${tag}`);
    const option = page.getByRole('option', { name: new RegExp(name) }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(option).toContainText(description);
    await expect(option).toContainText(`Tags: ${tag}`);
    await option.click();
    await expect(option).toBeHidden();
    expect(
      requests.some(
        (request) =>
          request.query === tag &&
          Array.isArray(request.kinds) &&
          request.kinds.length === 1 &&
          request.kinds[0] === 'image'
      )
    ).toBe(true);
  });

  test('filters and renders real image metadata in the unified @ query', async ({ page }) => {
    const suffix = Date.now().toString(36);
    const tag = `mention-image-${suffix}`;
    const name = `mention-search-${suffix}.png`;
    const description = `Mention visual ${suffix}`;
    const created = await jsonRequest<ApiResponse<ImageDto>>(`${server.api}/images`, 'POST', {
      name,
      dataUrl: PNG_DATA_URL,
      description,
      tags: [tag],
    });
    const requests: Array<Record<string, unknown>> = [];
    await proxyPaletteToScratch(page, server, requests);

    const editor = await openHookCodeEditor(page);
    await replaceEditorText(editor, `@image:${tag}`);
    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });
    const option = suggestions.getByRole('option', { name: new RegExp(name) }).first();
    await expect(option).toBeVisible({ timeout: 20_000 });
    await expect(option).toContainText(description);
    await expect(option).toContainText(`Tags: ${tag}`);
    await option.click();
    await expect(suggestions).toBeHidden();
    expect(await editor.evaluate((element) => element.textContent ?? '')).toBe(
      `'${created.data.id}'`
    );
    expect(
      requests.some(
        (request) =>
          request.query === tag &&
          Array.isArray(request.kinds) &&
          request.kinds.length === 1 &&
          request.kinds[0] === 'image'
      )
    ).toBe(true);
  });
});
