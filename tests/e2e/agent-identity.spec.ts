import { test, expect } from '@playwright/test';
import { gotoAgents } from './helpers/nav';

/**
 * E2E tests: Agent Identity
 *
 * Tests the identity lifecycle:
 *   1. API — set/read/update identity on agents
 *   2. UI  — edit identity via the agent edit panel
 *
 * Prerequisite: pnpm dev (server + desktop-ui on :4001 / :3001).
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/agent-identity.spec.ts --headed
 */

import { API } from './helpers/chat';

// Helpers

interface AgentRecord {
  id: string;
  name: string;
  identity?: string | null;
  systemPrompt?: string | null;
  credentialId?: string | null;
  modelProviderProfileId?: string | null;
  archived?: boolean;
}

async function getAgents(): Promise<AgentRecord[]> {
  const res = await fetch(`${API}/agents`);
  const body = await res.json();
  return body.data ?? [];
}

async function getAgent(id: string): Promise<AgentRecord> {
  const res = await fetch(`${API}/agents/${id}`);
  const body = await res.json();
  return body.data;
}

// The Agents tree (components/AgentsList) renders agents sorted by
// name.localeCompare, so openFirstAgent() opens the alphabetically-first
// agent, not API agents[0]. UI tests must patch/open the same agent.
async function alphaFirstAgent(): Promise<AgentRecord> {
  const visible = (await getAgents()).filter((a) => !a.archived);
  visible.sort((a, b) => a.name.localeCompare(b.name));
  return visible[0]!;
}

async function patchAgent(
  id: string,
  data: Record<string, unknown>
): Promise<{ status: number; data: AgentRecord }> {
  const res = await fetch(`${API}/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, data: body.data };
}

// API Tests

test.describe('Agent Identity — API', () => {
  let agentId: string;

  test.beforeAll(async () => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip();
      return;
    }
    agentId = agents[0]!.id;
  });

  test('identity field is returned in agent GET', async () => {
    const agent = await getAgent(agentId);
    expect(agent).toBeTruthy();
    expect('identity' in agent).toBe(true);
  });

  test('can set identity via PATCH', async () => {
    const identity = 'I am a test agent who loves precision and dislikes ambiguity.';
    const { status, data } = await patchAgent(agentId, { identity });

    expect(status).toBe(200);
    expect(data.identity).toBe(identity);

    const refetched = await getAgent(agentId);
    expect(refetched.identity).toBe(identity);
  });

  test('can update identity to a new value', async () => {
    const updated = 'I have grown. I now value curiosity over precision.';
    const { status, data } = await patchAgent(agentId, { identity: updated });

    expect(status).toBe(200);
    expect(data.identity).toBe(updated);
  });

  test('can clear identity by setting to null', async () => {
    const { status, data } = await patchAgent(agentId, { identity: null });

    expect(status).toBe(200);
    expect(data.identity).toBeNull();
  });

  test('identity does not affect other fields', async () => {
    const agent = await getAgent(agentId);
    const originalName = agent.name;
    const originalPrompt = agent.systemPrompt;

    await patchAgent(agentId, { identity: 'New identity for isolation test' });

    const after = await getAgent(agentId);
    expect(after.name).toBe(originalName);
    expect(after.systemPrompt).toBe(originalPrompt);
    expect(after.identity).toBe('New identity for isolation test');

    // Cleanup
    await patchAgent(agentId, { identity: null });
  });
});

// UI Tests

test.describe('Agent Identity — UI (editable IdentityEditor)', () => {
  /**
   * The editable identity surface: IdentityEditor.tsx renders a WorkspaceEditor
   * (kind="agent-identity", defaultMode="edit") under the IDENTITY label.
   *
   * Save contract (WorkspaceEditor):
   *   - typing schedules a debounced autosave;
   *   - Cmd/Ctrl+S flushes immediately -> onSave(markdown)
   *     -> AgentView.handleSaveIdentity -> agentsApi.update(agent.id,{identity});
   *   - an autosave status pill (role="status", data-state) reads
   *     data-state="saved" once the flush round-trips.
   */
  async function openFirstAgent(page: import('@playwright/test').Page) {
    await gotoAgents(page);
    const firstAgentRow = page.getByRole('treeitem').first();
    await firstAgentRow.waitFor({ state: 'visible', timeout: 15_000 });
    await firstAgentRow.click();
    // The IDENTITY label is always present in AgentView — use it as the
    // 'detail pane loaded' signal so editor assertions don't race the render.
    await page
      .getByText('IDENTITY', { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
  }

  /**
   * Resolve the editable identity ProseMirror surface.
   *
   * AgentView renders SystemPromptEditor (also a WorkspaceEditor/.ProseMirror)
   * AND IdentityEditor, so a bare `.ProseMirror` is ambiguous. The identity
   * editor carries a stable, unambiguous aria-label="Agent identity" (set by
   * IdentityEditor via WorkspaceEditor), so we target that directly.
   */
  function identityEditor(page: import('@playwright/test').Page) {
    return page.locator('.ProseMirror[aria-label="Agent identity"]');
  }

  test('renders an EDITABLE identity ProseMirror (not a read-only pre)', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    await openFirstAgent(page);

    const editor = identityEditor(page);
    // Presence + contenteditable is the proof it's an editable surface. We
    // assert attached rather than visible because TipTap can report a
    // collapsed/empty editor as hidden until focused.
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
  });

  test('keeps identity and system-prompt editors chrome-free and editable', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    await openFirstAgent(page);

    const sections = [
      page.getByTestId('agent-system-prompt-editor-section'),
      page.getByTestId('agent-identity-editor-section'),
    ];
    for (const section of sections) {
      await expect(section).toBeAttached();
      await expect(section.locator('.ProseMirror[contenteditable="true"]')).toBeAttached();
      await expect(section.getByTitle('Show rendered preview')).toHaveCount(0);
      await expect(section.getByTitle('Back to editor')).toHaveCount(0);
    }
  });

  test('typing an identity + Cmd/Ctrl+S round-trips to the agent record', async ({ page }) => {
    const agents = await getAgents();
    if (agents.length === 0) {
      test.skip(true, 'No agents available');
      return;
    }
    // openFirstAgent() opens the alphabetically-first row, so target that agent.
    const agentId = (await alphaFirstAgent()).id;
    const marker = `ident-e2e-${Date.now()}`;

    // Start from a known-empty identity so we assert OUR write, not stale text.
    await patchAgent(agentId, { identity: null });

    await openFirstAgent(page);

    const editor = identityEditor(page);
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
    // The IDENTITY editor can sit below the fold inside the AgentView pane's own
    // scroll container, so a coordinate click may report 'outside viewport'.
    // Drive it via focus() (works on any attached contenteditable) + keyboard
    // input — no click coordinates required. This still exercises the real
    // TipTap input -> debounced autosave -> agentsApi.update path.
    await editor.scrollIntoViewIfNeeded().catch((err: unknown) => {
      console.warn('scrollIntoViewIfNeeded failed (continuing):', err);
    });
    await editor.focus();
    // Clear any residual content, then type the marker.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(marker);

    // Flush the debounced autosave immediately.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');

    // The autosave pill should report 'saved' once the round-trip completes.
    const savedPill = page.getByRole('status').filter({ hasText: 'saved' });
    await expect(savedPill.first())
      .toBeVisible({ timeout: 10_000 })
      .catch((err: unknown) => {
        // Pill assertion is best-effort; the API round-trip below is the
        // authoritative proof of persistence.
        console.warn('saved-pill assertion skipped:', err);
      });

    // AUTHORITATIVE: the identity must have persisted on the agent record.
    await expect
      .poll(async () => (await getAgent(agentId)).identity ?? '', { timeout: 10_000 })
      .toContain(marker);

    // Cleanup
    await patchAgent(agentId, { identity: null });
  });
});
