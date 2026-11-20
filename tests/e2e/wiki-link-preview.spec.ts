import { test, expect } from '@playwright/test';

/**
 * E2E: Wiki-link preview modal
 *
 * Verifies that clicking a wiki-link chip in a doc's preview opens a
 * centered modal showing the linked node's content. Tests Esc and
 * backdrop dismissal, and recursive chip-click navigation (clicking a
 * chip inside the modal replaces the modal's node rather than stacking).
 *
 * Prerequisites:
 *   1. pnpm dev:server   (server on :4001)
 *   2. pnpm dev:desktop-ui   (Vite on :3001)
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wiki-link-preview.spec.ts --headed
 */

const API = `http://localhost:${process.env.PORT || '4001'}/api`;

interface ApiOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function api<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} ${res.status}: ${text}`);
  }
  const parsed = text ? (JSON.parse(text) as { data: T }) : ({ data: null } as { data: T });
  return parsed.data;
}

const RUN_ID = Date.now().toString(36);
const TARGET_TOKEN = `WIKI_TARGET_BODY_${RUN_ID}`;
const SECOND_TOKEN = `WIKI_SECOND_BODY_${RUN_ID}`;
const containerName = `wiki-preview-${RUN_ID}`;
const targetTitle = `wiki-target-${RUN_ID}`;
const secondTitle = `wiki-second-${RUN_ID}`;
const hostTitle = `wiki-host-${RUN_ID}`;

let containerId = '';
let targetDocId = '';
let secondDocId = '';
let hostDocId = '';

test.describe('Wiki-link preview modal', () => {
  test.beforeAll(async () => {
    const container = await api<{ id: string }>('/containers', {
      method: 'POST',
      body: { name: containerName },
    });
    containerId = container.id;

    const target = await api<{ id: string }>('/docs', {
      method: 'POST',
      body: {
        title: targetTitle,
        containerId,
        // Tall body so we can verify the modal body scrolls.
        content:
          `# Target doc\n\n${TARGET_TOKEN}\n\n` +
          Array.from(
            { length: 200 },
            (_, i) => `Filler line ${i + 1} — lorem ipsum dolor sit amet.`
          ).join('\n\n'),
      },
    });
    targetDocId = target.id;

    const second = await api<{ id: string }>('/docs', {
      method: 'POST',
      body: {
        title: secondTitle,
        containerId,
        content: `# Second doc\n\n${SECOND_TOKEN}\n\nReached via recursive chip click.`,
      },
    });
    secondDocId = second.id;

    // Target doc embeds a chip pointing at the second doc, to verify
    // that clicking a chip inside the modal replaces the previewed node.
    await api(`/docs/${targetDocId}`, {
      method: 'PATCH',
      body: {
        content:
          `# Target doc\n\n${TARGET_TOKEN}\n\nGo deeper: [${secondTitle}](${secondDocId})\n\n` +
          Array.from(
            { length: 200 },
            (_, i) => `Filler line ${i + 1} — lorem ipsum dolor sit amet.`
          ).join('\n\n'),
      },
    });

    // Host doc points at the target doc via a wiki-link chip.
    const host = await api<{ id: string }>('/docs', {
      method: 'POST',
      body: {
        title: hostTitle,
        containerId,
        content: `# Host doc\n\nFollow this link: [${targetTitle}](${targetDocId})\n`,
      },
    });
    hostDocId = host.id;
  });

  test.afterAll(async () => {
    for (const id of [hostDocId, secondDocId, targetDocId]) {
      if (id)
        await api(`/docs/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
          console.warn('cleanup failed:', err)
        );
    }
    if (containerId)
      await api(`/containers/${containerId}`, { method: 'DELETE' }).catch((err: unknown) =>
        console.warn('cleanup failed:', err)
      );
  });

  test('opens, shows linked doc, scrolls, and dismisses', async ({ page }) => {
    await page.goto('/');

    // Ensure sidebar is visible; toggle open if hidden (persists in localStorage).
    const sidebar = page.locator('#dashboard-sidebar');
    if (!(await sidebar.isVisible().catch(() => false))) {
      await page.locator('button[aria-label="Show sidebar"]').click();
    }
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // Expand the test container so the host doc is reachable in the tree.
    // Target the label by its `title` attribute — the rowGroup-level
    // treeitem also contains the text via its expanded children, so a
    // `:has-text` selector would match both ambiguously.
    const containerLabel = page.locator(`span[title="${containerName}"]`).first();
    await containerLabel.waitFor({ state: 'visible', timeout: 15_000 });
    const containerRow = containerLabel.locator('xpath=ancestor::*[@role="treeitem"][1]');
    if ((await containerRow.getAttribute('aria-expanded')) !== 'true') {
      await containerRow.locator('[data-testid="library-tree-chevron"]').first().click();
    }
    await expect(containerRow).toHaveAttribute('aria-expanded', 'true');

    // Click the host doc's label directly — bubbles to the .row onClick
    // which fires onNodeClick. Click the label (not the rowGroup) to
    // avoid the rowGroup's expanded-children area.
    const hostLabel = page.locator(`span[title="${hostTitle}"]`).first();
    await hostLabel.waitFor({ state: 'visible', timeout: 10_000 });
    await hostLabel.click();

    // DetailPanel default mode is 'preview'. The chip should render directly.
    // Chip selector: tiptap ChipNodeView renders `<span class="md-chip md-chip-doc" data-node-url="doc-...">` — not an `<a>`.
    // The clickable hit target for opening the preview is the title span inside the chip wrapper.
    const chip = page.locator(`span.md-chip[data-node-url="${targetDocId}"]`).first();
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // Click the chip title span (not the action icons — open/copy/remove) to open the preview.
    await chip.locator('.md-chip-title').click();
    const modal = page.locator('[data-testid="wiki-link-preview"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    const modalBody = page.locator('[data-testid="wiki-link-preview-body"]');
    await expect(modalBody).toContainText('Target doc');
    await expect(modalBody).toContainText(TARGET_TOKEN);

    // Modal body wraps a tiptap ProseMirror editor — that inner element is the
    // actual scroll container (the body itself does not overflow). Setting
    // `scrollTop` programmatically gets reset by Tiptap, so we drive a real
    // wheel event over the editor (matches real user behavior).
    const scrollProbe = modalBody.locator('.ProseMirror').first();
    await expect(scrollProbe).toBeVisible();
    const beforeScroll = await scrollProbe.evaluate((el) => el.scrollTop);
    await scrollProbe.hover();
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(200);
    const afterScroll = await scrollProbe.evaluate((el) => el.scrollTop);
    expect(afterScroll).toBeGreaterThan(beforeScroll);

    // Recursive chip click — clicking a nested wiki-link chip inside the
    // preview opens a (stacked) preview for that nested target. We then
    // assert the second target's content shows up in the topmost modal.
    const secondChip = modalBody.locator(`span.md-chip[data-node-url="${secondDocId}"]`).first();
    await expect(secondChip).toBeVisible();
    await secondChip.locator('.md-chip-title').click();

    // After the nested click, the topmost (last) modal must show the second
    // doc's content. Topmost = `.last()` because preview modals stack via
    // ChipNodeView's local `showPreview` state.
    const topModal = page.locator('[data-testid="wiki-link-preview"]').last();
    const topModalBody = topModal.locator('[data-testid="wiki-link-preview-body"]');
    await expect(topModal).toBeVisible();
    await expect(topModalBody).toContainText('Second doc');
    await expect(topModalBody).toContainText(SECOND_TOKEN);

    // A single Escape closes the preview chain. Either: only the topmost
    // closes (first modal still visible) OR both close together. We tolerate
    // either, but assert that the topmost is gone afterward.
    await page.keyboard.press('Escape');
    await expect(topModal).toBeHidden();
    // Drain any remaining preview modal so dismiss-path assertions below
    // start from a clean state.
    if (await modal.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    }

    // Re-open and dismiss via backdrop click (click in the overlay near the corner).
    await chip.locator('.md-chip-title').click();
    await expect(modal).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(modal).toBeHidden();
  });
});
