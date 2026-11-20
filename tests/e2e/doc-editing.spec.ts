import { test, expect } from '@playwright/test';

/**
 * Doc editing — the workspace editor (Tiptap-based WorkspaceEditor).
 *
 * This is the rich-text editor used to edit any doc in the workspace
 * sidebar. Distinct from:
 *   - the agent-identity editor (cloned variant tested in agent-identity.spec.ts)
 *   - chip-only inputs (chat composer)
 *
 * Coverage targets (all hard assertions — no flake-tolerant probes):
 *  1. Created doc renders its initial content.
 *  2. Typing into the editor mutates the content (in-memory).
 *  3. After typing, the server-side content persists (round-trip via API).
 *  4. Heading creation (#-shortcut) creates a heading node.
 *  5. Inline wiki-link `[label](doc-...)` writes round-trip and render as
 *     `span.md-chip[data-node-url]`.
 *
 * Setup: one fresh container + one fresh doc per test for hermetic isolation.
 */

type Created<T> = { data: T };

// Same convention as helpers/chat.ts — the API port comes from the harness
// env, never a hardcoded dev port (which may belong to a different instance).
const API = `http://localhost:${process.env.PORT || '4001'}/api`;

async function createDoc(page: import('@playwright/test').Page, title: string, content = '') {
  const j = async <T>(r: { json: () => Promise<Created<T>> }) => (await r.json()).data;
  const cont = await page.request
    .post(`${API}/containers`, {
      data: { name: `probe-doc-edit-${Date.now().toString(36)}` },
    })
    .then((r) => j<{ id: string; name: string }>(r));
  const doc = await page.request
    .post(`${API}/docs`, {
      data: { title, content, containerId: cont.id },
    })
    .then((r) => j<{ id: string }>(r));
  return { containerName: cont.name, containerId: cont.id, docId: doc.id, docTitle: title };
}

async function openDoc(
  page: import('@playwright/test').Page,
  containerName: string,
  docTitle: string
) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByText(containerName).first().click();
  await page.waitForTimeout(300);
  await page.getByText(docTitle).first().click();
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  return editor;
}

async function getDocContent(
  page: import('@playwright/test').Page,
  docId: string
): Promise<string> {
  const res = await page.request.get(`${API}/docs/${docId}`);
  const j = (await res.json()) as { data: { content: string } };
  return j.data.content;
}

test.describe('Doc editor — WorkspaceEditor', () => {
  test("renders the doc's initial content", async ({ page }) => {
    const seedToken = `SEED_${Date.now().toString(36)}`;
    const { containerName, docTitle } = await createDoc(
      page,
      `RenderInitial-${Date.now().toString(36)}`,
      `Hello world\n\n${seedToken}\n\nGoodbye world`
    );
    const editor = await openDoc(page, containerName, docTitle);
    await expect(editor).toContainText(seedToken);
    await expect(editor).toContainText('Hello world');
    await expect(editor).toContainText('Goodbye world');
  });

  test('typing in the editor persists to the server', async ({ page }) => {
    const { containerName, docTitle, docId } = await createDoc(
      page,
      `Persist-${Date.now().toString(36)}`,
      'Initial body.\n\n'
    );
    const editor = await openDoc(page, containerName, docTitle);

    const newSentence = ` TYPED_${Date.now().toString(36)} appended.`;
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(newSentence);

    // Workspace editor autosaves on idle. Poll the server until the new text
    // shows up in the persisted content, up to 6s.
    const target = newSentence.trim();
    await expect
      .poll(async () => await getDocContent(page, docId), {
        timeout: 6000,
        message: 'typed content should round-trip through the autosave to the server',
      })
      .toContain(target);
  });

  test('heading shortcut (`# `) creates a heading node', async ({ page }) => {
    const { containerName, docTitle } = await createDoc(
      page,
      `Heading-${Date.now().toString(36)}`,
      '\n\n'
    );
    const editor = await openDoc(page, containerName, docTitle);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    const headingText = `HEADING_${Date.now().toString(36)}`;
    await page.keyboard.type(`# ${headingText}`);
    // After `# ` the input rule should have converted the line into a heading.
    const heading = editor.locator(`h1:has-text("${headingText}")`).first();
    await expect(heading).toBeVisible();
  });

  test('inline wiki-link renders as a chip', async ({ page }) => {
    // Target doc — what the wiki-link points at.
    const tsKey = Date.now().toString(36);
    const cont = await page.request
      .post(`${API}/containers`, { data: { name: `probe-link-${tsKey}` } })
      .then((r) => r.json())
      .then((j: Created<{ id: string; name: string }>) => j.data);
    const target = await page.request
      .post(`${API}/docs`, {
        data: { title: `LinkTarget-${tsKey}`, content: 'target body', containerId: cont.id },
      })
      .then((r) => r.json())
      .then((j: Created<{ id: string }>) => j.data);
    const hostTitle = `LinkHost-${tsKey}`;
    await page.request.post(`${API}/docs`, {
      data: {
        title: hostTitle,
        content: `Point to [LinkTarget](${target.id}) please.`,
        containerId: cont.id,
      },
    });

    const editor = await openDoc(page, cont.name, hostTitle);
    // Chip is a span (not an <a>) with `data-node-url` per ChipNodeView.tsx.
    const chip = editor.locator(`span.md-chip[data-node-url="${target.id}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('LinkTarget');
  });
});
