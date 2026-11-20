import { test, expect, type Page } from '@playwright/test';
import { openApp, gotoAgents, gotoLibrary } from './helpers/nav';
import { runPrefix } from './helpers/workspace';

/**
 * Stale-while-revalidate freshness for the fetch-once data surfaces.
 *
 * The model/credential dropdowns (useModelData) and the agent-settings MCP
 * server list (useMcpServers) revalidate on every mount, and a failed
 * revalidation keeps the cached options instead of blanking them. All three
 * contracts are pinned here without any page reload:
 *
 *   1. a model row added via the API appears in the agent-settings Model
 *      dropdown on the next mount of the pane;
 *   2. an MCP server added via the API appears in the agent-settings MCP
 *      section on the next mount, and disappears again after deletion;
 *   3. when the models API starts failing, the dropdown keeps its cached
 *      options (no blanked select, no stranded spinner).
 *
 * Credential rows go through the same `useModelData` triple
 * (providers+models+credentials in one revalidation), but creating one via
 * the API requires a secret that verifies against the live provider — so the
 * model row is the deterministic probe for that shared path.
 */

const API = `http://localhost:${process.env.PORT || '4001'}/api`;

interface AgentRow {
  id: string;
  name: string;
  provider?: string | null;
  archived?: boolean;
}

async function firstAgent(): Promise<AgentRow> {
  const res = await fetch(`${API}/agents`);
  const body = (await res.json()) as { data?: AgentRow[] };
  const agent = (body.data ?? []).find((a) => !a.archived && a.id !== 'ghost' && a.provider);
  if (!agent) throw new Error('no provider-backed agent available in this workspace');
  return agent;
}

/** Open the given agent's settings pane via the Agents sidebar roster. */
async function openAgentPane(page: Page, agentName: string): Promise<void> {
  await gotoAgents(page);
  const row = page.getByRole('treeitem', { name: new RegExp(agentName) }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
  // The agent pane's header + Model section are the mount signals.
  await page
    .getByRole('heading', { name: agentName, exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .getByRole('heading', { name: 'Model', exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Remount the agent pane without reloading. Switching the sidebar view leaves
 * the pane content mounted, so bounce the pane itself through another agent —
 * selecting a different agent swaps the pane and re-mounts the data surfaces
 * when we come back.
 */
async function remountAgentPane(page: Page, agentName: string, viaAgent: string): Promise<void> {
  await openAgentPane(page, viaAgent);
  await openAgentPane(page, agentName);
}

function modelSelect(page: Page) {
  // The editor renders <label><span>Model</span><select>…</label>; the select
  // carries no accessible name of its own (getByLabel cannot resolve it), so
  // target the structure. Two Provider/Model/Credential groups render (agent
  // model + summary override); the agent's own Model select comes first.
  return page.locator('label:has(span:text-is("Model")) select').first();
}

test.describe('agent settings — data surfaces revalidate on every mount', () => {
  const modelId = `${runPrefix('freshmodel')}`;
  const mcpServerId = runPrefix('freshmcp');
  const probeAgentName = runPrefix('fresh-pane');
  let probeAgentId: string | null = null;
  let anchorAgent: AgentRow;
  let createdModelRowId: string | null = null;

  test.beforeAll(async () => {
    // The pane under test: a provider-less probe agent, so its Model select
    // lists every model (no provider filter) and assertions stay
    // provider-agnostic. The anchor (a seeded agent) is the bounce target
    // that forces a true pane remount between assertions.
    anchorAgent = await firstAgent();
    const res = await fetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: probeAgentName, role: 'e2e freshness probe' }),
    });
    if (!res.ok) throw new Error(`probe agent create failed: HTTP ${res.status}`);
    probeAgentId = ((await res.json()) as { data?: { id?: string } }).data?.id ?? null;
  });

  test.afterAll(async () => {
    if (probeAgentId) {
      await fetch(`${API}/agents/${probeAgentId}`, { method: 'DELETE' }).catch((err: unknown) =>
        console.warn('best-effort cleanup failed:', err)
      );
    }
    if (createdModelRowId) {
      await fetch(`${API}/models/${createdModelRowId}`, { method: 'DELETE' }).catch(
        (err: unknown) => console.warn('best-effort cleanup failed:', err)
      );
    }
    await fetch(`${API}/mcp/servers/${mcpServerId}`, { method: 'DELETE' }).catch((err: unknown) =>
      console.warn('best-effort cleanup failed:', err)
    );
  });

  test('a model added via the API appears in the Model dropdown on next mount — no reload', async ({
    page,
  }) => {
    await openApp(page);
    await openAgentPane(page, probeAgentName);

    // Baseline: the yet-to-be-created model is not an option.
    await expect(modelSelect(page).locator(`option[value="${modelId}"]`)).toHaveCount(0);

    // Out-of-band DB change (another pane / an agent at runtime).
    const created = await fetch(`${API}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: anchorAgent.provider,
        modelId,
        displayName: `E2E fresh model ${modelId}`,
      }),
    });
    expect(created.status).toBe(201);
    createdModelRowId = ((await created.json()) as { data?: { id?: string } }).data?.id ?? null;

    // Remount the pane (no page reload) → revalidation must pick it up.
    await remountAgentPane(page, probeAgentName, anchorAgent.name);
    await expect(modelSelect(page).locator(`option[value="${modelId}"]`)).toHaveCount(1, {
      timeout: 15_000,
    });
  });

  test('a failed models refresh keeps the cached options instead of blanking', async ({ page }) => {
    await openApp(page);
    await openAgentPane(page, probeAgentName);

    // Seed the session cache with a healthy fetch, and note the option count.
    const select = modelSelect(page);
    await expect
      .poll(async () => await select.locator('option').count(), { timeout: 15_000 })
      .toBeGreaterThan(1);
    const healthyOptionCount = await select.locator('option').count();

    // Break the models API, then remount. The SWR contract: cached options
    // keep rendering; the select must not collapse to empty.
    await page.route('**/api/models', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: 'e2e simulated outage' } }),
        });
        return;
      }
      await route.fallback();
    });

    await remountAgentPane(page, probeAgentName, anchorAgent.name);
    await expect
      .poll(async () => await modelSelect(page).locator('option').count(), { timeout: 15_000 })
      .toBe(healthyOptionCount);

    await page.unroute('**/api/models');
  });

  test('an MCP server added via the API appears in agent settings on next mount, and deletion removes it', async ({
    page,
  }) => {
    await openApp(page);
    await openAgentPane(page, probeAgentName);

    const mcpHeading = page.getByRole('heading', { name: 'MCP servers', exact: true });
    await expect(mcpHeading).toBeVisible();
    await expect(page.getByText(mcpServerId, { exact: true })).toHaveCount(0);

    // Create a (never-connecting) stdio server out-of-band.
    const created = await fetch(`${API}/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: mcpServerId,
        name: `E2E Fresh MCP ${mcpServerId}`,
        transport: 'stdio',
        command: 'true',
        enabled: true,
      }),
    });
    expect(created.status).toBe(201);

    // Remount → the new server is offered for per-agent enablement.
    await remountAgentPane(page, probeAgentName, anchorAgent.name);
    await expect(page.getByText(mcpServerId, { exact: true })).toBeVisible({ timeout: 15_000 });

    // Delete it → next mount drops it from the list again.
    const deleted = await fetch(`${API}/mcp/servers/${mcpServerId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    await remountAgentPane(page, probeAgentName, anchorAgent.name);
    await expect(mcpHeading).toBeVisible();
    await expect(page.getByText(mcpServerId, { exact: true })).toHaveCount(0);
  });
});
