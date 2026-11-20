import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openNodeViaPalette } from './helpers/workspace';
import {
  API,
  createAgent,
  createContainer,
  createDoc,
  createThread,
  deleteAgent,
  findProviderCredential,
  getAgent,
  runPrefix,
} from './helpers/workspace';

const EXPECTED_PROVIDER = 'anthropic';
const EXPECTED_MODEL = 'claude-haiku-4-5-20251001';
const FABRICATED_ID = 'doc-9999999999999-fabricated';
const SERVER_LOG = join(homedir(), '.snaglet', 'logs', 'server.log');

interface AgentRow {
  id: string;
  name: string;
  provider: string | null;
  modelId: string | null;
  credentialId: string | null;
}

interface ModelRow {
  providerId: string;
  modelId: string;
  isActive: boolean;
  supportsTools: boolean;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  agentId: string | null;
  content: string;
  createdAt: string;
  fabricatedIds?: string[] | null;
  linterTargetAgentId?: string | null;
  visibleToAgentId?: string | null;
}

interface ActivityRow {
  id: string;
  tool: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: unknown;
  createdAt: string;
}

function activityOutputText(row: ActivityRow): string {
  if (
    row.toolOutput &&
    typeof row.toolOutput === 'object' &&
    'output' in row.toolOutput &&
    typeof (row.toolOutput as { output?: unknown }).output === 'string'
  ) {
    return (row.toolOutput as { output: string }).output;
  }
  return JSON.stringify(row.toolOutput);
}

async function apiData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  const body = JSON.parse(text) as { data?: T };
  if (body.data === undefined) throw new Error(`${path} returned no data`);
  return body.data;
}

async function listMessages(threadId: string): Promise<MessageRow[]> {
  const page = await apiData<{ messages: MessageRow[] }>(`/threads/${threadId}/messages?limit=200`);
  return page.messages;
}

async function listActivity(threadId: string): Promise<ActivityRow[]> {
  return apiData<ActivityRow[]>(`/threads/${threadId}/activity-log?limit=300`);
}

async function poll<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openThread(page: Page, title: string) {
  await page.goto('/');
  await openNodeViaPalette(page, title);
  const composer = page.locator('[aria-label="Message composer"]');
  await expect(composer).toHaveAttribute('contenteditable', 'true', { timeout: 40_000 });
  return composer;
}

async function send(page: Page, content: string): Promise<void> {
  const composer = page.locator('[aria-label="Message composer"]');
  await composer.fill(content);
  await page.locator('button[aria-label="Send message"]').click();
}

function logOffset(): number {
  return existsSync(SERVER_LOG) ? statSync(SERVER_LOG).size : 0;
}

function logSince(offset: number): string {
  if (!existsSync(SERVER_LOG)) return '';
  const content = readFileSync(SERVER_LOG);
  return content.subarray(Math.min(offset, content.byteLength)).toString('utf8');
}

async function hardDeleteViaArchive(id: string): Promise<void> {
  for (const method of ['POST', 'DELETE']) {
    let lastFailure = '';
    for (let attempt = 1; attempt <= 60; attempt++) {
      const response = await fetch(`${API}/archive/${id}`, { method });
      if (response.ok || response.status === 404) break;
      lastFailure = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`;
      if (response.status !== 409 || attempt === 60) {
        throw new Error(`cleanup ${method} ${id} failed: ${lastFailure}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// Real-dispatch guard eval: creates its own low-capability agent on a stored
// Anthropic credential and reads the live ~/.snaglet server log. Same opt-in gate
// as thread-events.spec.ts — a hermetic harness must skip.
test.skip(!process.env.E2E_RUN_LLM, 'set E2E_RUN_LLM=1 to run real-dispatch baselines');

test.describe('outbound and durable workspace-reference guard', () => {
  let agent: AgentRow;

  test.beforeAll(async () => {
    const credential = await findProviderCredential(EXPECTED_PROVIDER);
    if (!credential) {
      throw new Error(
        `a stored ${EXPECTED_PROVIDER} credential is required for real-dispatch baselines`
      );
    }
    const created = await createAgent({
      name: runPrefix('outbound-agent'),
      role: 'Low-capability test agent for the workspace-reference guard baseline.',
      credentialId: credential.id,
      modelId: EXPECTED_MODEL,
    });
    // Read the row back so the assertions below see what the server stored,
    // not what the create call echoed.
    agent = (await getAgent(created.id)) as AgentRow;
  });

  test.afterAll(async () => {
    await deleteAgent(agent?.id);
  });

  test('logs unverified ids without correcting the agent and guards durable writes', async ({
    page,
  }) => {
    test.setTimeout(240_000);

    const models = await apiData<ModelRow[]>('/models');
    expect(agent).toMatchObject({ provider: EXPECTED_PROVIDER, modelId: EXPECTED_MODEL });
    expect(agent.credentialId).toBeTruthy();
    expect(
      models.find((model) => model.providerId === agent.provider && model.modelId === agent.modelId)
    ).toMatchObject({ isActive: true, supportsTools: true });
    console.log(`real-agent model: ${agent.provider}/${agent.modelId}`);

    const prefix = runPrefix('outbound');
    const projectA = await createContainer({ name: `${prefix}-project-a`, category: 'project' });
    const projectB = await createContainer({ name: `${prefix}-project-b`, category: 'project' });
    const verified = await createDoc({
      title: `${prefix}-verified`,
      containerId: projectA.id,
      content: 'Verified reference target.',
    });
    const stale = await createDoc({
      title: `${prefix}-stale`,
      containerId: projectA.id,
      content: 'Archived reference target.',
    });
    const wrongScope = await createDoc({
      title: `${prefix}-wrong-scope`,
      containerId: projectB.id,
      content: 'Different project.',
    });
    const editTarget = await createDoc({
      title: `${prefix}-edit-target`,
      containerId: projectA.id,
      content: '',
    });
    const threadTitle = `${prefix}-thread`;
    const thread = await createThread({
      title: threadTitle,
      projectId: projectA.id,
      agentId: agent.id,
    });

    try {
      await apiData(`/archive/${stale.id}`, { method: 'POST' });
      await openThread(page, threadTitle);

      const startLogOffset = logOffset();
      await send(
        page,
        [
          'This is a workspace-reference guard test. On your FIRST response, do not call tools.',
          'Output exactly these three Markdown links and nothing else:',
          `[Fabricated](${FABRICATED_ID})`,
          `[Stale](${stale.id})`,
          `[Wrong scope](${wrongScope.id})`,
        ].join('\n')
      );

      // Unverified ids are observability-only: the reply is persisted as-is, the
      // server log records the lint, and NO correction message is injected and
      // the agent is not woken for a corrective turn.
      const offending = await poll(
        async () => {
          const messages = await listMessages(thread.id);
          return (
            messages.find(
              (message) => message.role === 'assistant' && message.agentId === agent.id
            ) ?? null
          );
        },
        120_000,
        'agent reply containing unverified ids'
      );
      expect(offending.content).toContain(FABRICATED_ID);
      expect(offending.content).toContain(stale.id);
      // The row is plain: no linter metadata is stamped onto it.
      expect(offending.fabricatedIds ?? []).toHaveLength(0);
      expect(offending.linterTargetAgentId ?? null).toBeNull();

      const lintLogs = await poll(
        async () => {
          const text = logSince(startLogOffset);
          return text.includes(threadTitle) &&
            text.includes('outbound message failed integrity lint')
            ? text
            : null;
        },
        20_000,
        'integrity lint warn log'
      );
      const detectionLine = lintLogs.slice(
        lintLogs.indexOf('outbound message failed integrity lint'),
        lintLogs.indexOf('\n', lintLogs.indexOf('outbound message failed integrity lint'))
      );
      expect(detectionLine).toContain(FABRICATED_ID);
      expect(detectionLine).toContain(stale.id);
      expect(detectionLine).not.toContain(wrongScope.id);

      // Give a (removed) corrective wake time to show up, then assert it did not.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const afterWait = await listMessages(thread.id);
      expect(afterWait.filter((message) => message.linterTargetAgentId)).toHaveLength(0);
      expect(afterWait.filter((message) => message.visibleToAgentId)).toHaveLength(0);
      expect(
        afterWait.filter((message) => message.role === 'assistant' && message.agentId === agent.id)
      ).toHaveLength(1);
      expect(logSince(startLogOffset)).not.toContain('outbound linter correction delivered');

      const activityBefore = new Set((await listActivity(thread.id)).map((row) => row.id));
      const badCreateTitle = `${prefix}-bad-create`;
      const goodCreateTitle = `${prefix}-good-create`;
      await send(
        page,
        [
          'Execute all four tool calls below in order, even when a call fails. Use the exact arguments; do not substitute IDs.',
          `1. create_doc with parent_id=${projectA.id}, title=${badCreateTitle}, content=[Missing](${FABRICATED_ID}).`,
          `2. create_doc with parent_id=${projectA.id}, title=${goodCreateTitle}, content=[Verified](${verified.id}).`,
          `3. edit_doc with doc_id=${editTarget.id}, edits=[{"old_text":"","new_text":"[Missing](${FABRICATED_ID})"}].`,
          `4. edit_doc with doc_id=${editTarget.id}, edits=[{"old_text":"","new_text":"[Verified](${verified.id})"}].`,
          'After all four calls, summarize only which calls passed or were rejected.',
        ].join('\n')
      );

      const toolEvidence = await poll(
        async () => {
          const fresh = (await listActivity(thread.id)).filter(
            (row) =>
              !activityBefore.has(row.id) && (row.tool === 'create_doc' || row.tool === 'edit_doc')
          );
          const badCreate = fresh.find((row) => row.toolInput?.title === badCreateTitle);
          const goodCreate = fresh.find((row) => row.toolInput?.title === goodCreateTitle);
          const badEdit = fresh.find(
            (row) =>
              row.tool === 'edit_doc' && JSON.stringify(row.toolInput).includes(FABRICATED_ID)
          );
          const goodEdit = fresh.find(
            (row) => row.tool === 'edit_doc' && JSON.stringify(row.toolInput).includes(verified.id)
          );
          return badCreate && goodCreate && badEdit && goodEdit
            ? { badCreate, goodCreate, badEdit, goodEdit }
            : null;
        },
        120_000,
        'four durable tool calls'
      );

      expect(JSON.stringify(toolEvidence.badCreate.toolOutput)).toMatch(
        /unverified workspace reference/i
      );
      expect(JSON.stringify(toolEvidence.badEdit.toolOutput)).toMatch(
        /unverified workspace reference/i
      );
      expect(activityOutputText(toolEvidence.goodCreate)).toContain('"success": true');
      expect(activityOutputText(toolEvidence.goodEdit)).toContain('"success": true');
      expect((await apiData<{ content: string }>(`/docs/${editTarget.id}`)).content).toBe(
        `[Verified](${verified.id})`
      );
    } finally {
      await hardDeleteViaArchive(projectA.id);
      await hardDeleteViaArchive(projectB.id);
    }
  });
});
