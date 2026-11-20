import { expect, test, type Locator, type Page } from '@playwright/test';
// Relative import: @snaglet/sdk is not linked into the root node_modules the way
// @snaglet/db and @snaglet/shared are, and the e2e tree resolves from the repo root.
import { HOOK_EVENT_NAMES } from '../../packages/snaglet-sdk/index';

// Canonical runtime-event registry — imported so this spec can never drift
// from the app's event list.
const TRIGGERS = HOOK_EVENT_NAMES;

const NODE_ID = 'doc-1111111111111-fixture01';
const NODE_TITLE = 'Hook editor: @-query';

async function openHookCodeEditor(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: /^Automations\b/ }).click();
  await page.getByRole('button', { name: 'New automation or script', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New script', exact: true }).click();
  // The New-hook panel surfaces the code editor directly; a Code tab exists
  // only in the multi-tab builder layout. Click it when present.
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

async function editorText(editor: Locator): Promise<string> {
  return editor.evaluate((element) => element.textContent ?? '');
}

test.describe('hook editor unified @ search', () => {
  test('shows one consolidated trigger panel with exactly the eight runtime events', async ({
    page,
  }) => {
    const editor = await openHookCodeEditor(page);
    await replaceEditorText(editor, '@trigger:');

    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(suggestions).toHaveCount(1);
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('option')).toHaveCount(TRIGGERS.length);

    const optionText = await suggestions.getByRole('option').allTextContents();
    for (const trigger of TRIGGERS) {
      expect(optionText.filter((text) => text.includes(trigger))).toHaveLength(1);
    }

    // No double panel: CodeMirror's native
    // autocomplete must not remain visible behind the unified mention panel.
    await expect(page.locator('.cm-tooltip-autocomplete:visible')).toHaveCount(0);
  });

  test('filters locally and commits trigger choices by keyboard and mouse', async ({ page }) => {
    const editor = await openHookCodeEditor(page);
    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });

    // 'agent:update' also substring-matches container:update in the grown
    // registry — assert the exact hit ranks first and Enter commits it.
    await replaceEditorText(editor, 'const event = @trigger:agent:update');
    await expect(suggestions.getByRole('option')).toHaveCount(2);
    await expect(suggestions.getByRole('option').first()).toContainText('agent:update');
    await editor.press('Enter');
    await expect(suggestions).toBeHidden();
    expect(await editorText(editor)).toBe("const event = 'agent:update'");

    await replaceEditorText(editor, '@trigger:delete');
    await expect(suggestions.getByRole('option')).toHaveCount(1);
    await suggestions.getByRole('option').click();
    await expect(suggestions).toBeHidden();
    expect(await editorText(editor)).toBe("'agent:delete'");
  });

  test('dismisses safely, rejects embedded @ tokens, and reopens for a new token', async ({
    page,
  }) => {
    const editor = await openHookCodeEditor(page);
    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });

    await replaceEditorText(editor, '@trigger:agent');
    await expect(suggestions).toBeVisible();
    await editor.press('Escape');
    await expect(suggestions).toBeHidden();

    // Typing within the dismissed token must not immediately resurrect it.
    await editor.pressSequentially(':update');
    await expect(suggestions).toBeHidden();

    await editor.pressSequentially(' @trigger:run');
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('option')).toHaveCount(1);
    await expect(suggestions.getByRole('option').first()).toContainText('run:end');
    await page
      .getByText('hook.ts is the source of truth for triggers, filters, and behavior.')
      .click();
    await expect(suggestions).toBeHidden();

    await replaceEditorText(editor, 'const email = foo@bar');
    await expect(suggestions).toBeHidden();
  });

  test('uses the same single panel for scoped node search and inserts only the canonical id', async ({
    page,
  }) => {
    const requests: Array<Record<string, unknown>> = [];
    const editor = await openHookCodeEditor(page);
    // Install deterministic search transport only after the lazy editor bundle
    // is loaded (page routes disable the browser cache). The browser still has
    // to issue the correctly scoped palette request and render/select its hit.
    await page.route('**/api/search/palette', async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            byKind: {
              doc: [
                {
                  node_id: NODE_ID,
                  kind: 'doc',
                  score: 1,
                  channels: ['fts'],
                  payload: { title: 'Hook editor: @-query with trigger search' },
                },
              ],
            },
            channelsUsed: ['fts'],
            semanticStatus: 'disabled',
            coverage: { doc: 'lexical' },
            filesystem: [],
            files: [],
          },
        }),
      });
    });
    await replaceEditorText(editor, '@doc:Hook editor');

    const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });
    await expect(suggestions).toHaveCount(1);
    await expect(suggestions.getByRole('option', { name: new RegExp(NODE_TITLE) })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.cm-tooltip-autocomplete:visible')).toHaveCount(0);
    await suggestions.getByRole('option', { name: new RegExp(NODE_TITLE) }).click();
    expect(await editorText(editor)).toBe(`'${NODE_ID}'`);

    const scopedRequests = requests.filter((request) =>
      String(request.query ?? '').includes('Hook editor')
    );
    expect(scopedRequests.length).toBeGreaterThan(0);
    for (const request of scopedRequests) expect(request.kinds).toEqual(['doc']);
  });

  test('inserts dropped editor chips (the restored drag-insert path)', async ({ page }) => {
    // Chips drag-insert into the handler editor; the root advertises itself
    // to usePaneDropZone so pane-split hover chrome never fights the drop.
    const editor = await openHookCodeEditor(page);
    await replaceEditorText(editor, 'export default async function handler() {}');
    const before = await editorText(editor);
    const root = page.getByTestId('handler-editor');

    await expect(root).toHaveAttribute('data-pane-drop-target', 'node-chip');
    await root.evaluate((element) => {
      const transfer = new DataTransfer();
      // EDITOR_CHIP_MIME carries a JSON EditorChipPayload (editorChip.ts) —
      // the chip precomputes the exact quoted literal to insert.
      transfer.setData(
        'application/x-snaglet-editor-chip',
        JSON.stringify({ text: "'message:create'" })
      );
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });

    const after = await editorText(editor);
    expect(after).not.toBe(before);
    expect(after).toContain("'message:create'");
  });
});
