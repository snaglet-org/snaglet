import { expect, type Page } from '@playwright/test';

/**
 * Shared helpers for the UI flow specs (doc/container properties,
 * status-by-move, thread events, palette, MCP keys).
 *
 * These specs run against the live dev workspace + DB (see playwright.config.ts
 * — baseURL is the running Vite UI, API is the running Express server). So they
 * must be self-contained and self-cleaning: every artifact is created with a
 * unique per-run prefix and torn down in afterAll. They never touch
 * pre-existing user data — each spec creates its own throwaway nodes.
 */

/** API base — matches helpers/chat.ts. */
export const API = `http://localhost:${process.env.PORT || '4001'}/api`;

/** A unique-per-run prefix so parallel/repeat runs never collide or leak. */
export function runPrefix(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function apiJson<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${ctx} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let body: ApiEnvelope<T>;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new Error(`${ctx}: non-JSON response ${text.slice(0, 200)}`);
  }
  if (body.data === undefined) throw new Error(`${ctx}: missing data ${text.slice(0, 200)}`);
  return body.data;
}

// Node CRUD (used for setup + outcome assertions)

export interface ContainerRec {
  id: string;
  name: string;
  category: string | null;
  folderPath: string | null;
}

export interface DocRec {
  id: string;
  title: string;
  containerId: string | null;
  dueAt: string | null;
  priority: string | null;
  assignedTo: string | null;
}

export async function createContainer(input: {
  name: string;
  parentId?: string | null;
  category?: string;
}): Promise<ContainerRec> {
  const res = await fetch(`${API}/containers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return apiJson<ContainerRec>(res, 'createContainer');
}

export async function createDoc(input: {
  title: string;
  containerId?: string | null;
  content?: string;
}): Promise<DocRec> {
  const res = await fetch(`${API}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return apiJson<DocRec>(res, 'createDoc');
}

/** Best-effort delete; swallows errors so afterAll never fails a green run. */
export async function deleteDoc(id: string | null | undefined): Promise<void> {
  if (!id) return;
  await fetch(`${API}/docs/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
    console.warn('best-effort cleanup failed:', err)
  );
}

export async function deleteContainer(id: string | null | undefined): Promise<void> {
  if (!id) return;
  await fetch(`${API}/containers/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
    console.warn('best-effort cleanup failed:', err)
  );
}

export async function deleteThread(id: string | null | undefined): Promise<void> {
  if (!id) return;
  await fetch(`${API}/threads/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
    console.warn('best-effort cleanup failed:', err)
  );
}

// Threads (thread-events spec)

export interface AgentRec {
  id: string;
  name: string;
  provider?: string;
  credentialId?: string | null;
  modelId?: string | null;
}

export async function listAgents(): Promise<AgentRec[]> {
  const res = await fetch(`${API}/agents`);
  const body = (await res.json()) as ApiEnvelope<AgentRec[]>;
  return body.data ?? [];
}

export async function getAgent(id: string): Promise<AgentRec> {
  const res = await fetch(`${API}/agents/${id}`);
  return apiJson<AgentRec>(res, 'getAgent');
}

/**
 * Create a throwaway agent. With `credentialId` the server derives the
 * provider from the credential; `modelId` is stored as given. Specs that need
 * a real model pair this with `findProviderCredential`.
 */
export async function createAgent(input: {
  name: string;
  role?: string;
  credentialId?: string | null;
  modelId?: string | null;
  provider?: string | null;
}): Promise<AgentRec> {
  const res = await fetch(`${API}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return apiJson<AgentRec>(res, 'createAgent');
}

/** Best-effort removal of a spec-created agent; a missing id is a no-op. */
export async function deleteAgent(id: string | null | undefined): Promise<void> {
  if (!id) return;
  await fetch(`${API}/agents/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
    console.warn('best-effort agent cleanup failed:', err)
  );
}

export interface ProviderCredentialRec {
  id: string;
  providerId: string;
  label: string;
  hasSecret: boolean;
  verificationStatus: 'untested' | 'ok' | 'fail';
}

/**
 * The first stored credential for `providerId` that holds a secret and has
 * not failed verification, or null. Real-dispatch specs use this to attach a
 * live key to the agent they create instead of depending on a pre-configured
 * agent in someone's workspace.
 */
export async function findProviderCredential(
  providerId: string
): Promise<ProviderCredentialRec | null> {
  const res = await fetch(`${API}/providers/credentials`);
  const credentials = await apiJson<ProviderCredentialRec[]>(res, 'listProviderCredentials');
  return (
    credentials.find(
      (c) => c.providerId === providerId && c.hasSecret && c.verificationStatus !== 'fail'
    ) ?? null
  );
}

/** `projectId` scopes the thread to a project container; omitted or null = flat. */
export async function createThread(input: {
  title: string;
  projectId?: string | null;
  agentId?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return apiJson<{ id: string }>(res, 'createThread');
}

/** Adds a roster participant — persists a `participant_added` thread_event
 *  immediately (no LLM dispatch), which is the zero-cost way to render a
 *  threadEventRow. */
export async function addThreadParticipant(threadId: string, agentId: string): Promise<void> {
  const res = await fetch(`${API}/threads/${threadId}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) {
    throw new Error(
      `addThreadParticipant failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
    );
  }
}

// MCP keys

export interface McpKeyRec {
  id: string;
  name: string;
}

export async function listMcpKeys(): Promise<McpKeyRec[]> {
  const res = await fetch(`${API}/mcp-keys`);
  const body = (await res.json()) as ApiEnvelope<McpKeyRec[]>;
  return body.data ?? [];
}

export async function revokeMcpKey(id: string): Promise<void> {
  await fetch(`${API}/mcp-keys/${id}/revoke`, { method: 'POST' }).catch((err: unknown) =>
    console.warn('best-effort cleanup failed:', err)
  );
}

// UI navigation primitives

/**
 * Open the Properties panel in the active pane.
 *
 * The panel mounts closed every time its view mounts. The only way to see the
 * property fields is the way a user does it: press the pane topbar's
 * Properties toggle after the node is open. Call after openNodeViaPalette
 * (and again after any reload — the panel is closed again on remount).
 */
export async function openPropertiesDisclosure(page: Page): Promise<void> {
  const trigger = page.locator('main').first().getByTestId('properties-toggle').first();
  await trigger.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Open a workspace node (doc / container / thread) in the active pane by
 * searching for it in the Command Palette and clicking the result.
 *
 * This is the reliable way to open an API-created node without depending on
 * sidebar-tree expansion state: the palette calls `invalidate()` on open and
 * re-fetches the workspace tree, so a just-created node appears in the instant
 * (lexical) tier. Uses a unique title so exactly one result matches.
 */
export async function openNodeViaPalette(page: Page, title: string): Promise<void> {
  const isMac = process.platform === 'darwin';
  // The palette hotkey is global; app shell must be interactive first.
  await page.getByRole('tab').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');

  const dialog = page.getByRole('dialog', { name: 'Quick search' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  const input = page.getByRole('textbox', { name: 'Quick search' });
  await input.fill(title);

  // The result row is role=option; its accessible name contains the title.
  const option = dialog.getByRole('option', { name: title }).first();
  await option.waitFor({ state: 'visible', timeout: 15_000 });
  await option.click();

  // Selecting a node closes the palette and opens it in the pane.
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}

/** Guard against a blank-screen crash: the ActivityBar tablist must survive. */
export async function expectAppAlive(page: Page): Promise<void> {
  await expect(page.getByRole('tab').first()).toBeVisible();
}
