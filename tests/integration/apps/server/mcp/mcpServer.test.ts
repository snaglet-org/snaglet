/**
 * Snaglet's external MCP server surface (/mcp) with a real DB, ToolService registry
 * and MCP SDK transport (stateless + enableJsonResponse). Covers key
 * mint/list/revoke, Bearer auth (missing/invalid/revoked, a key from another Snaglet
 * home, untagged tokens), tools/list (exactly the curated tier), tools/call
 * execution and result shape, attribution stamping (created_by = the key's
 * external member), the project-category guard on container update, and the
 * semantic_file_search external constraint (project_id required).
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { Agents, Containers, McpApiKeys, Members, Threads, getDb } from '@snaglet/db';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { errorHandler } from '@server/middleware';
import { registerActorMemberResolver } from '@server/realtime/actorMember';
import mcpGatewayRoutes from '@server/domains/mcp/mcp.routes';
import mcpApiKeysRoutes from '@server/domains/mcp/mcpApiKeys.routes';
import { hashMcpKeyToken } from '@server/domains/mcp/mcpAuth';
import { SNAGLET_HOME, SNAGLET_RUNTIME_DIR } from '@server/services/snagletHome';
import { CURATED_TOOL_IDS } from '@server/domains/mcp/mcpProjection';
import { hooks, type HookEventMap } from '@server/services/HookService';

const RUN_TAG = `mcptest-${Date.now()}`;
const INVALID_KEY_MESSAGE =
  'Invalid or revoked API key. If you run more than one Snaglet (an installed app and a dev server), check SNAGLET_HOME / which Snaglet app is running.';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/mcp', mcpGatewayRoutes);
  app.use('/api/mcp-keys', mcpApiKeysRoutes);
  app.use(errorHandler);
  return app;
}

// Full-suite parallel runs can starve this suite (fresh MCP Server+transport
// per request); jest's 5s default is too tight under load — same budget
// treatment as resetCatalogSeeding and other module-level test seams.
jest.setTimeout(30_000);

// serverConfig is read from PORT / API_BASE_URL / CREDENTIAL_ENCRYPTION_KEY in
// the environment or a .env file found by walking up from the checkout. A clean
// checkout (CI, a fresh worktree) has none, serverConfig degrades to `{}` and
// connect-info loses `port`. Pin it so the test never depends on a developer's
// local .env (the unit route test pins it the same way).
jest.mock('@server/config', () => ({ serverConfig: { port: 51234 } }));

describe('MCP server surface (/mcp)', () => {
  let app: Express;
  let token: string;
  let memberId: string;
  let keyId: string;
  const createdNodeIds: string[] = [];
  const createdMemberIds: string[] = [];
  const createdAgentIds: string[] = [];

  async function rpc(body: Record<string, unknown>, auth?: string) {
    const req = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json');
    if (auth) req.set('Authorization', `Bearer ${auth}`);
    return req.send(body);
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    id = 100
  ): Promise<JsonRpcResponse> {
    const res = await rpc(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      token
    );
    expect(res.status).toBe(200);
    return res.body as JsonRpcResponse;
  }

  beforeAll(async () => {
    // Boot wiring (index.ts does this at startup): the attribution stamps
    // resolve the ambient actor through this seam.
    registerActorMemberResolver();
    app = makeApp();
    const minted = await request(app)
      .post('/api/mcp-keys')
      .send({ name: `${RUN_TAG}-client` });
    expect(minted.status).toBe(201);
    token = minted.body.data.token;
    memberId = minted.body.data.key.memberId;
    keyId = minted.body.data.key.id;
    createdMemberIds.push(memberId);
  });

  afterAll(async () => {
    const pool = getDb();
    if (createdNodeIds.length > 0) {
      await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [createdNodeIds]);
    }
    if (createdAgentIds.length > 0) {
      await pool.query(`DELETE FROM public.agents WHERE id = ANY($1::text[])`, [createdAgentIds]);
    }
    if (createdMemberIds.length > 0) {
      // Cascades the mcp_api_keys rows.
      await pool.query(`DELETE FROM public.members WHERE id = ANY($1::text[])`, [createdMemberIds]);
    }
  });

  describe('key management (/api/mcp-keys)', () => {
    it('mints a key mapped to an external member and returns the token once', async () => {
      // Tagged with this Snaglet home: snaglet_mcp_<8 hex>_<48 hex>.
      expect(token).toMatch(/^snaglet_mcp_[0-9a-f]{8}_[0-9a-f]{48}$/);
      const member = await Members.findById(memberId);
      expect(member?.kind).toBe('external');
      expect(member?.agentId).toBeNull();
      expect(member?.userId).toBeNull();
    });

    it('lists keys without ever exposing the hash or token', async () => {
      const res = await request(app).get('/api/mcp-keys');
      expect(res.status).toBe(200);
      const row = (res.body.data as Array<Record<string, unknown>>).find((k) => k.id === keyId);
      expect(row).toBeDefined();
      expect(row!.name).toBe(`${RUN_TAG}-client`);
      expect(row!.keyHash).toBeUndefined();
      expect(row!.token).toBeUndefined();
    });

    it('rejects minting without a name', async () => {
      const res = await request(app).post('/api/mcp-keys').send({});
      expect(res.status).toBe(400);
    });

    it('renames a client connection without exposing or replacing its key', async () => {
      const renamedName = `${RUN_TAG}-renamed-client`;
      const renamed = await request(app).patch(`/api/mcp-keys/${keyId}`).send({
        name: renamedName,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ id: keyId, name: renamedName });
      expect(renamed.body.data.token).toBeUndefined();
      expect(renamed.body.data.keyHash).toBeUndefined();

      const listed = await request(app).get('/api/mcp-keys');
      const row = (listed.body.data as Array<{ id: string; name: string }>).find(
        (key) => key.id === keyId
      );
      expect(row?.name).toBe(renamedName);
    });

    it('rejects blank client connection names', async () => {
      const res = await request(app).patch(`/api/mcp-keys/${keyId}`).send({ name: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('connect info', () => {
    it('GET /api/mcp-keys/connect-info answers the setup facts, never a key', async () => {
      const res = await request(app).get('/api/mcp-keys/connect-info');
      expect(res.status).toBe(200);
      const info = res.body.data as Record<string, unknown>;
      expect(Object.keys(info).sort()).toEqual([
        'cliOnPath',
        'cliPath',
        'isDefaultHome',
        'mcpUrl',
        'port',
        'profile',
        'snagletHome',
      ]);
      expect(info.port).toBe(51234);
      expect(info.mcpUrl).toBe(`http://127.0.0.1:${String(info.port)}/mcp`);
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toMatch(/snaglet_mcp_/);
    });

    it('is not reachable through /mcp: an external client has no such tool', async () => {
      const body = await callTool('snaglet_connect_info', {}, 31);
      expect((body.result as { isError?: boolean }).isError).toBe(true);
      const listed = await rpc({ jsonrpc: '2.0', id: 32, method: 'tools/list' }, token);
      const names = ((listed.body as JsonRpcResponse).result!.tools as Array<{ name: string }>).map(
        (tool) => tool.name
      );
      expect(names.some((name) => /connect|mcp_key/i.test(name))).toBe(false);
    });
  });

  describe('auth', () => {
    it('401s without a key', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/API key/i);
    });

    it('401s with an invalid key', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'snaglet_mcp_notakey');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe(INVALID_KEY_MESSAGE);
    });

    describe('wrong Snaglet home', () => {
      const tagOf = (key: string) => key.slice('snaglet_mcp_'.length, 'snaglet_mcp_'.length + 8);
      const otherTag = (tag: string) => tag.replace(/^./, (first) => (first === '0' ? '1' : '0'));
      const secret = 'ab'.repeat(24);

      it('the tag is random, kept in the home’s runtime/mcp-key-tag, and shared by every key minted here', async () => {
        const saved = readFileSync(join(SNAGLET_RUNTIME_DIR, 'mcp-key-tag'), 'utf8').trim();
        expect(saved).toMatch(/^[0-9a-f]{8}$/);
        expect(tagOf(token)).toBe(saved);
        const again = await request(app)
          .post('/api/mcp-keys')
          .send({ name: `${RUN_TAG}-same-home` });
        createdMemberIds.push(again.body.data.key.memberId);
        expect(tagOf(again.body.data.token)).toBe(saved);
        // Not derived from the home's path, so the 401 wording cannot confirm a guessed SNAGLET_HOME.
        for (const home of [SNAGLET_HOME, realpathSync(SNAGLET_HOME)]) {
          const pathTag = createHash('sha256')
            .update(`snaglet-home:${home}`, 'utf8')
            .digest('hex')
            .slice(0, 8);
          expect(saved).not.toBe(pathTag);
        }
      });

      it('a key tagged by another home says so, naming no home or tag', async () => {
        const foreign = `snaglet_mcp_${otherTag(tagOf(token))}_${secret}`;
        const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, foreign);
        expect(res.status).toBe(401);
        expect(res.body.error.message).toBe(
          "This key isn't valid for this Snaglet: it was made by a different Snaglet home. Check SNAGLET_HOME / which Snaglet app is running."
        );
        expect(res.body.error.message).not.toContain(tagOf(token));
        expect(res.body.error.message).not.toContain(otherTag(tagOf(token)));
        expect(res.body.error.message).not.toMatch(/\.snaglet|\/Users\/|\/home\//);
      });

      it('an unknown key with this home’s tag is invalid or revoked, with the more-than-one-Snaglet hint', async () => {
        const unknown = `snaglet_mcp_${tagOf(token)}_${secret}`;
        const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, unknown);
        expect(res.status).toBe(401);
        expect(res.body.error.message).toBe(INVALID_KEY_MESSAGE);
        expect(res.body.error.message).not.toContain(tagOf(token));
      });

      it('an unknown untagged key is invalid or revoked, never "another home"', async () => {
        const res = await rpc(
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          `snaglet_mcp_${secret}`
        );
        expect(res.status).toBe(401);
        expect(res.body.error.message).toBe(INVALID_KEY_MESSAGE);
      });

      it('an untagged token is refused even when its hash is stored', async () => {
        const member = await Members.createExternal();
        createdMemberIds.push(member.id);
        const untagged = `snaglet_mcp_${'cd'.repeat(24)}`;
        await McpApiKeys.create({
          memberId: member.id,
          name: `${RUN_TAG}-untagged`,
          keyHash: hashMcpKeyToken(untagged),
        });
        const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, untagged);
        expect(res.status).toBe(401);
        expect(res.body.error.message).toBe(INVALID_KEY_MESSAGE);
      });

      it('the tag never accepts a key: a valid key works whatever tag it carries', async () => {
        // A key whose stored hash matches is accepted even when its tag is not this home's
        // (the tag only words the 401).
        const member = await Members.createExternal();
        createdMemberIds.push(member.id);
        const foreignTagged = `snaglet_mcp_${otherTag(tagOf(token))}_${'ef'.repeat(24)}`;
        await McpApiKeys.create({
          memberId: member.id,
          name: `${RUN_TAG}-foreign-tag`,
          keyHash: hashMcpKeyToken(foreignTagged),
        });
        const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, foreignTagged);
        expect(res.status).toBe(200);
      });
    });

    it('401s with a revoked key', async () => {
      const minted = await request(app)
        .post('/api/mcp-keys')
        .send({ name: `${RUN_TAG}-revoked` });
      expect(minted.status).toBe(201);
      createdMemberIds.push(minted.body.data.key.memberId);

      const revoked = await request(app).post(`/api/mcp-keys/${minted.body.data.key.id}/revoke`);
      expect(revoked.status).toBe(200);
      // Revocation deletes the row — it must be gone from the list.
      const listed = await request(app).get('/api/mcp-keys');
      expect(
        (listed.body.data as Array<{ id: string }>).some((k) => k.id === minted.body.data.key.id)
      ).toBe(false);

      const res = await rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        minted.body.data.token
      );
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe(INVALID_KEY_MESSAGE);
    });
  });

  describe('MCP protocol', () => {
    it('answers initialize with the snaglet server identity', async () => {
      const res = await rpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'jest', version: '0' },
          },
        },
        token
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonRpcResponse;
      expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('snaglet');
    });

    it('tools/list returns exactly the curated tier, snaglet_-prefixed, schemas intact', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);
      expect(res.status).toBe(200);
      const tools = (res.body as JsonRpcResponse).result!.tools as Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;

      expect(tools.map((t) => t.name)).toEqual(CURATED_TOOL_IDS.map((id) => `snaglet_${id}`));
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.description.length).toBeGreaterThan(0);
      }
      // No leaks: nothing outside the tier, under any name.
      const names = new Set(tools.map((t) => t.name));
      expect(names.has('snaglet_thread')).toBe(true);
      expect(names.has('snaglet_thread_send')).toBe(false); // old name still callable, not listed
      for (const leak of ['snaglet_shell_exec', 'snaglet_memory_recall', 'shell_exec']) {
        expect(names.has(leak)).toBe(false);
      }
    });

    it('thread_send posts as the authenticated external member without agent impersonation', async () => {
      const threadId = `${RUN_TAG}-thread-send`;
      const content = `${RUN_TAG} external checkpoint`;
      await Threads.create({ id: threadId, title: `${RUN_TAG} MCP thread_send` });
      createdNodeIds.push(threadId);

      const body = await callTool('snaglet_thread_send', { id: threadId, content }, 21);
      const result = body.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      const posted = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(posted).toMatchObject({
        success: true,
        thread_id: threadId,
        sender_member_id: memberId,
        posted: true,
      });

      const { rows } = await getDb().query<{
        role: string;
        agent_id: string | null;
        content: string;
        metadata: { externalSender?: { memberId?: string; name?: string } } | null;
      }>(
        `SELECT role, agent_id, content, metadata
           FROM public.messages
          WHERE id = $1`,
        [posted.message_id]
      );
      expect(rows[0]).toMatchObject({ role: 'user', agent_id: null, content });
      expect(rows[0]?.metadata?.externalSender?.memberId).toBe(memberId);

      const denied = await callTool(
        'snaglet_thread_send',
        { id: threadId, content: 'impersonation attempt', sender_agent_id: 'vega' },
        22
      );
      const deniedResult = denied.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(deniedResult.isError).toBe(true);
      expect(deniedResult.content[0]!.text).toMatch(/`sender_agent_id` is not a parameter/);
    });

    it('supports the guarded external orchestration flow end to end', async () => {
      const agentName = `${RUN_TAG}-reviewer`;
      const agentCreated = new Promise<HookEventMap['agent:create']>((resolve) => {
        hooks.once('agent:create', resolve);
      });
      const createdAgent = await callTool(
        'snaglet_create_agent',
        {
          name: agentName,
          role: 'Reviewer',
          provider: 'anthropic',
          tool_access_mode: 'all',
        },
        23
      );
      const createdAgentResult = createdAgent.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(createdAgentResult.isError).toBeFalsy();
      const agentPayload = JSON.parse(createdAgentResult.content[0]!.text) as {
        success: boolean;
        agent_id: string;
      };
      expect(agentPayload.success).toBe(true);
      createdAgentIds.push(agentPayload.agent_id);
      await expect(agentCreated).resolves.toEqual(
        expect.objectContaining({
          id: agentPayload.agent_id,
          createdBy: { kind: 'external', id: memberId },
        })
      );

      // An external get is the slim roster: no params.
      const roster = await callTool('snaglet_get_agent', {}, 24);
      const rosterResult = roster.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(rosterResult.isError).toBeFalsy();
      const rosterPayload = JSON.parse(rosterResult.content[0]!.text) as {
        agents: Array<{ id: string }>;
      };
      expect(rosterPayload.agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: agentPayload.agent_id })])
      );

      const threadTitle = `${RUN_TAG}-orchestration-thread`;
      const createdThread = await callTool(
        'snaglet_thread_create',
        { title: threadTitle, project_id: null, dispatch_mode: 'mentioned' },
        25
      );
      const createdThreadResult = createdThread.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(createdThreadResult.isError).toBeFalsy();
      const { rows: threadRows } = await getDb().query<{ id: string }>(
        `SELECT id FROM public.threads WHERE title = $1`,
        [threadTitle]
      );
      expect(threadRows).toHaveLength(1);
      const threadId = threadRows[0]!.id;
      createdNodeIds.push(threadId);

      // Agents join through op add_agents.
      const addEvent = new Promise<HookEventMap['thread:update']>((resolve) => {
        hooks.once('thread:update', resolve);
      });
      const added = await callTool(
        'snaglet_thread',
        { op: 'add_agents', id: threadId, agent_ids: [agentPayload.agent_id] },
        26
      );
      const addedResult = added.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(addedResult.isError).toBeFalsy();
      expect(addedResult.content[0]!.text).toContain(agentPayload.agent_id);
      await expect(addEvent).resolves.toEqual(
        expect.objectContaining({
          id: threadId,
          updatedBy: { kind: 'external', id: memberId },
          changed: ['add_agents'],
          participantAgentIds: [agentPayload.agent_id],
          removedAgentIds: [],
        })
      );
      await expect(ThreadParticipants.listByThread(threadId)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ agentId: agentPayload.agent_id })])
      );

      // Adding the same agent again is a no-op, not an error.
      const readded = await callTool(
        'snaglet_thread',
        { op: 'add_agents', id: threadId, agent_ids: [agentPayload.agent_id] },
        46
      );
      const readdedResult = readded.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(readdedResult.isError).toBeFalsy();
      expect(
        (await ThreadParticipants.listByThread(threadId)).filter(
          (participant) => participant.agentId === agentPayload.agent_id
        )
      ).toHaveLength(1);

      const content = `${RUN_TAG} orchestration checkpoint`;
      const sent = await callTool('snaglet_thread_send', { id: threadId, content }, 27);
      const sentResult = sent.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(sentResult.isError).toBeFalsy();

      const read = await callTool('snaglet_thread_read', { id: threadId, limit: 10 }, 28);
      const readResult = read.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(readResult.isError).toBeFalsy();
      const readPayload = JSON.parse(readResult.content[0]!.text) as {
        thread: { id: string };
        messages: Array<{ content: string; agent_id: string | null }>;
      };
      expect(readPayload.thread.id).toBe(threadId);
      expect(readPayload.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content, agent_id: null })])
      );

      const models = await callTool('snaglet_list_models', { operation: 'providers' }, 29);
      const modelsResult = models.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(modelsResult.isError).toBeFalsy();
      expect(modelsResult.content[0]!.text).not.toMatch(/api[_-]?key|bearer token/i);

      const updateEvent = new Promise<HookEventMap['thread:update']>((resolve) => {
        hooks.once('thread:update', resolve);
      });
      const updated = await callTool(
        'snaglet_thread_update',
        {
          thread_id: threadId,
          thread: {
            title: `${threadTitle}-updated`,
            dispatch_mode: 'all',
            system_prompt: 'Coordinate the external review.',
            max_waves: 4,
            max_total_output_tokens: 1200,
            max_agent_dispatches: 6,
          },
        },
        34
      );
      const updatedResult = updated.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(updatedResult.isError).toBeFalsy();
      await expect(updateEvent).resolves.toEqual(
        expect.objectContaining({
          id: threadId,
          updatedBy: { kind: 'external', id: memberId },
          participantAgentIds: [],
        })
      );

      const persistedThread = await Threads.findById(threadId);
      expect(persistedThread).toMatchObject({
        title: `${threadTitle}-updated`,
        dispatchMode: 'all',
        threadSystemPrompt: 'Coordinate the external review.',
        maxWaves: 4,
        maxTotalOutputTokens: 1200,
        maxAgentDispatches: 6,
      });

      const partial = await callTool(
        'snaglet_thread_update',
        { thread_id: threadId, thread: { title: `${threadTitle}-partial` } },
        35
      );
      const partialResult = partial.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(partialResult.isError).toBeFalsy();
      await expect(Threads.findById(threadId)).resolves.toMatchObject({
        title: `${threadTitle}-partial`,
        dispatchMode: 'all',
        threadSystemPrompt: 'Coordinate the external review.',
        maxWaves: 4,
        maxTotalOutputTokens: 1200,
        maxAgentDispatches: 6,
      });
      await expect(ThreadParticipants.listByThread(threadId)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ agentId: agentPayload.agent_id })])
      );
    });

    it('denies sensitive orchestration edges before they mutate state', async () => {
      const fullAgent = await callTool('snaglet_get_agent', { agent: 'ghost' }, 31);
      const fullAgentResult = fullAgent.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(fullAgentResult.isError).toBe(true);
      expect(fullAgentResult.content[0]!.text).toMatch(
        /`agent` is not a parameter of snaglet_get_agent op get/
      );

      for (const [id, args, deniedParam] of [
        [
          32,
          { title: `${RUN_TAG}-human-injection`, participant_user_ids: [] },
          'participant_user_ids',
        ],
        [
          33,
          { title: `${RUN_TAG}-agent-impersonation`, initial_message: 'start' },
          'initial_message',
        ],
      ] as const) {
        const body = await callTool('snaglet_thread_create', args, id);
        const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain(deniedParam);
      }

      const { rows: deniedThreads } = await getDb().query<{ id: string }>(
        `SELECT id FROM public.threads WHERE title = ANY($1::text[])`,
        [[`${RUN_TAG}-human-injection`, `${RUN_TAG}-agent-impersonation`]]
      );
      expect(deniedThreads).toHaveLength(0);

      const updateThreadId = `thread-${RUN_TAG}-update-denials`;
      const updateAgentId = `agent-${RUN_TAG}-update-denials`;
      await Agents.create({
        id: updateAgentId,
        name: `${RUN_TAG}-update-denials`,
        providerId: 'anthropic',
        modelId: 'claude-initial',
      });
      createdAgentIds.push(updateAgentId);
      await Threads.create({
        id: updateThreadId,
        title: `${RUN_TAG}-unchanged`,
        dispatchMode: 'mentioned',
      });
      createdNodeIds.push(updateThreadId);
      await ThreadParticipants.addParticipant({
        threadId: updateThreadId,
        agentId: updateAgentId,
      });

      for (const [id, updateArgs, expectedError] of [
        [
          40,
          {
            thread_id: updateThreadId,
            thread: { title: `${RUN_TAG}-must-not-write`, dispatch_mode: 'random' },
          },
          /dispatch_mode/i,
        ],
        [
          41,
          {
            thread_id: updateThreadId,
            thread: { title: `${RUN_TAG}-must-not-write`, max_waves: 0 },
          },
          /max_waves/i,
        ],
        [
          42,
          {
            thread_id: updateThreadId,
            thread: { title: `${RUN_TAG}-must-not-write` },
            agent_ids: ['agent-does-not-exist'],
          },
          /`agent_ids` is not a parameter of snaglet_thread_update op update/,
        ],
        [
          43,
          {
            thread_id: updateThreadId,
            thread: { title: `${RUN_TAG}-must-not-write`, tool_access_mode: 'all' },
          },
          /`thread\.tool_access_mode` is not a parameter/,
        ],
        [
          44,
          {
            thread_id: updateThreadId,
            thread: { title: `${RUN_TAG}-must-not-write` },
            participants: [{ agent_id: updateAgentId, tool_access_mode: 'all' }],
          },
          /`participants` is not a parameter/,
        ],
      ] as const) {
        const denied = await callTool('snaglet_thread_update', updateArgs, id);
        const deniedResult = denied.result as {
          content: Array<{ text: string }>;
          isError?: boolean;
        };
        expect(deniedResult.isError).toBe(true);
        expect(deniedResult.content[0]!.text).toMatch(expectedError);
        await expect(Threads.findById(updateThreadId)).resolves.toMatchObject({
          title: `${RUN_TAG}-unchanged`,
          dispatchMode: 'mentioned',
          maxWaves: null,
        });
      }
      await expect(ThreadParticipants.listByThread(updateThreadId)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: updateAgentId, toolAccessMode: null }),
        ])
      );
    });

    it('tools/call workspace_search executes and returns MCP text content', async () => {
      const body = await callTool('snaglet_workspace_search', { query: 'anything at all' });
      const result = body.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]!.type).toBe('text');
      expect(typeof result.content[0]!.text).toBe('string');
      expect(result.isError).toBeFalsy();
    });

    it('snaglet_thread exposes only send/read/create/update/add_agents, with the same policies under the merged name', async () => {
      // The merged name with an uncurated op is denied before any handler runs.
      for (const [id, args] of [
        [41, { op: 'delete', id: 'thread-anything', confirm: true }],
        [43, { title: 'no-op given' }],
      ] as const) {
        const body = await callTool('snaglet_thread', args, id);
        const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(/Denied: op/);
      }
      // add_agent is not an op: agents join through op add_agents.
      const addAgent = await callTool(
        'snaglet_thread',
        { op: 'add_agent', id: 'thread-anything', agent_id: 'agent-anything' },
        47
      );
      const addAgentResult = addAgent.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(addAgentResult.isError).toBe(true);
      expect(addAgentResult.content[0]!.text).toMatch(/`add_agent` is not an op of snaglet_thread/);
      // set_prompt is not an op: the prompt changes only via update thread.system_prompt.
      const setPrompt = await callTool(
        'snaglet_thread',
        { op: 'set_prompt', id: 'thread-anything', system_prompt: 'x' },
        42
      );
      const setPromptResult = setPrompt.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(setPromptResult.isError).toBe(true);
      expect(setPromptResult.content[0]!.text).toMatch(
        /`set_prompt` is not an op of snaglet_thread/
      );
      // A per-op id for an uncurated op is app-local; a removed id is unknown.
      for (const [name, message] of [
        [
          'snaglet_thread_delete',
          /^Denied: snaglet_thread_delete is not available to external MCP clients/,
        ],
        ['snaglet_thread_system_prompt_update', /^Unknown tool/],
        ['snaglet_thread_add_agent', /^Unknown tool/],
      ] as const) {
        const body = await callTool(name, { id: 'thread-anything' }, 44);
        const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(message);
      }
      // The create policy keys on thread + op: same denial via the merged name.
      const body = await callTool(
        'snaglet_thread',
        { op: 'create', title: `${RUN_TAG}-merged-injection`, participant_user_ids: [] },
        45
      );
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('participant_user_ids');
    });

    it('rejects tools outside the curated tier', async () => {
      for (const [name, args] of [
        ['snaglet_shell_exec', { command: 'echo hi' }],
        [
          'snaglet_create_image',
          { title: 'x', mime_type: 'image/png', data_base64: 'iVBORw0KGgo=' },
        ],
      ] as const) {
        const body = await callTool(name, args);
        const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(/is not available to external MCP clients/);
      }
      const body = await callTool('snaglet_no_such_tool', {});
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Unknown tool: snaglet_no_such_tool/);
    });

    // Accept-header ergonomics: every response here is plain JSON
    // (enableJsonResponse), so plain-JSON callers — curl, hand-rolled
    // JSON-RPC clients — must be served without the SDK's ceremonial
    // "application/json AND text/event-stream" Accept pair.
    it('serves a caller that sends no Accept header (bare curl)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      expect(res.status).toBe(200);
      expect(Array.isArray((res.body as JsonRpcResponse).result?.tools)).toBe(true);
    });

    it('serves a caller that accepts only application/json', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
      expect(res.status).toBe(200);
      expect(Array.isArray((res.body as JsonRpcResponse).result?.tools)).toBe(true);
    });

    it('still 406es a caller that cannot accept JSON at all', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'text/html')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
      expect(res.status).toBe(406);
      expect((res.body as JsonRpcResponse).error?.message).toMatch(/Not Acceptable/);
    });
  });

  describe('attribution', () => {
    it('create_doc stamps created_by with the external member', async () => {
      const title = `${RUN_TAG}-attribution-doc`;
      const body = await callTool('snaglet_create_doc', { title });
      const result = body.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBeFalsy();

      const { rows } = await getDb().query<{ id: string; created_by: string | null }>(
        `SELECT id, created_by FROM public.docs WHERE title = $1`,
        [title]
      );
      expect(rows).toHaveLength(1);
      createdNodeIds.push(rows[0]!.id);
      expect(rows[0]!.created_by).toBe(memberId);
    });
  });

  describe('project category is fixed at creation', () => {
    it("cannot change a project container's category (not an update parameter)", async () => {
      const container = await Containers.create({
        name: `${RUN_TAG}-project`,
        category: 'project',
      });
      createdNodeIds.push(container.id);

      const body = await callTool('snaglet_update_container', {
        container_id: container.id,
        category: null,
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      // `category` is not in the external update shape, so the gateway refuses
      // it before any handler runs and nothing is written.
      expect(result.content[0]!.text).toMatch(
        /`category` is not a parameter of snaglet_update_container op update/
      );

      const { rows } = await getDb().query<{ category: string | null }>(
        `SELECT category FROM public.containers WHERE id = $1`,
        [container.id]
      );
      expect(rows[0]!.category).toBe('project'); // unchanged
    });

    it('still allows a harmless update_container (description on a plain container)', async () => {
      const container = await Containers.create({ name: `${RUN_TAG}-plain` });
      createdNodeIds.push(container.id);

      const body = await callTool('snaglet_update_container', {
        container_id: container.id,
        description: 'described',
      });
      const result = body.result as { isError?: boolean };
      expect(result.isError).toBeFalsy();
    });
  });

  describe('project-facet local-only constraint', () => {
    it('denies update_container with folder_path (project folder linking is local-only)', async () => {
      const container = await Containers.create({
        name: `${RUN_TAG}-facet-proj`,
        category: 'project',
      });
      createdNodeIds.push(container.id);

      const body = await callTool('snaglet_update_container', {
        container_id: container.id,
        folder_path: '/etc',
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/Denied/);
      expect(result.content[0]!.text).toMatch(/folder_path/);

      // Nothing was written — the call never reached the tool.
      const { rows } = await getDb().query<{ folder_path: string | null }>(
        `SELECT folder_path FROM public.containers WHERE id = $1`,
        [container.id]
      );
      expect(rows[0]!.folder_path).toBeNull();
    });

    it('denies update_container with github_url', async () => {
      const container = await Containers.create({
        name: `${RUN_TAG}-facet-git`,
        category: 'project',
      });
      createdNodeIds.push(container.id);

      const body = await callTool('snaglet_update_container', {
        container_id: container.id,
        github_url: 'https://github.com/acme/repo',
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/github_url/);
    });

    it('denies create_container with folder_path', async () => {
      const body = await callTool('snaglet_create_container', {
        name: `${RUN_TAG}-facet-create`,
        category: 'project',
        folder_path: '/etc',
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/Denied/);

      // The denial fires before the tool runs, so no container was created.
      const { rows } = await getDb().query<{ id: string }>(
        `SELECT id FROM public.containers WHERE name = $1`,
        [`${RUN_TAG}-facet-create`]
      );
      expect(rows).toHaveLength(0);
    });

    it('denies folder_path through the merged snaglet_container name too', async () => {
      const container = await Containers.create({
        name: `${RUN_TAG}-facet-merged`,
        category: 'project',
      });
      createdNodeIds.push(container.id);

      const body = await callTool('snaglet_container', {
        op: 'update',
        id: container.id,
        folder_path: '/etc',
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/folder_path/);

      const { rows } = await getDb().query<{ folder_path: string | null }>(
        `SELECT folder_path FROM public.containers WHERE id = $1`,
        [container.id]
      );
      expect(rows[0]!.folder_path).toBeNull();
    });

    it('allows update_container without any facet params (description only)', async () => {
      const container = await Containers.create({ name: `${RUN_TAG}-facet-ok` });
      createdNodeIds.push(container.id);

      // The point is that update_container works with no project facets.
      const body = await callTool('snaglet_update_container', {
        container_id: container.id,
        description: 'no facets here',
      });
      const result = body.result as { isError?: boolean };
      expect(result.isError).toBeFalsy();

      const { rows } = await getDb().query<{ description: string | null }>(
        `SELECT description FROM public.containers WHERE id = $1`,
        [container.id]
      );
      expect(rows[0]!.description).toBe('no facets here');
    });
  });

  describe('semantic_file_search external constraint', () => {
    it('rejects calls without project_id', async () => {
      const body = await callTool('snaglet_semantic_file_search', { query: 'auth middleware' });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/project_id/);
    });

    it('rejects unknown project ids instead of falling back to the host filesystem', async () => {
      const body = await callTool('snaglet_semantic_file_search', {
        query: 'auth middleware',
        project_id: `${RUN_TAG}-no-such-project`,
      });
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/Unknown project_id/);
    });
  });
});
