/**
 * memory-lifecycle.spec — live end-to-end pass over the compaction-time memory
 * loop (tail injection, extraction + verified/status columns, delta
 * broadcast), with the model boundary scripted by a fake
 * OpenAI-compatible provider and everything else real: a scratch Snaglet server on
 * its own throwaway managed PostgreSQL (full migration chain),
 * real socket dispatch, real compaction, real DB writes.
 *
 * The loop under test:
 *   seed thread → force compaction → summary (utility model) succeeds →
 *   extraction (utility model) returns agent + member + invalid candidates →
 *   agent memory lands verified=false/status='active' with provenance,
 *   member fact lands status='proposed' (inert), invalid candidate vanishes →
 *   socket:thread:memory-extraction broadcasts {saved:1, proposed:1} →
 *   the next turn's ephemeral turn-context tail carries the recalled memory
 *   line (keyword-only FTS admission — the scratch SNAGLET_HOME has no embedder
 *   model files, so every embed attempt fails and recall runs the
 *   keyword-only hybridSearch arm) → the proposed member fact appears in NO
 *   surface (not the tail, not memory_search).
 *
 * Word choice is load-bearing: the keyword recall arm is
 * `search_text @@ plainto_tsquery('english', query)` with AND semantics over
 * every non-stopword lexeme of (thread title + latest message), so the
 * extracted memory content deliberately contains every content word of the
 * thread title ("Chat with Quokka") and of the turn-4 probe message.
 */
import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ScratchServer } from './helpers/scratchServer';

interface ProviderMessageWire {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

interface ChatCompletionRequest {
  model: string;
  messages: ProviderMessageWire[];
  tools?: Array<{ type: 'function'; function: { name: string } }>;
}

interface SocketMessage {
  type: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

const AGENT_NAME = 'Quokka';

/** Agent-scoped candidate: auto-saves as active, verified=false. Content
 *  contains every non-stopword lexeme of the thread title and turn-4 probe. */
const AGENT_MEMORY_KEY = 'quokka-fluxcapacitor-toggle';
const AGENT_MEMORY_CONTENT =
  'Quokka chat deployment note: the deployment rollout requires the fluxcapacitor toggle.';

/** Member-scoped candidate: must land status='proposed', inert everywhere. */
const MEMBER_MEMORY_KEY = 'user-prefers-terse-updates';
const MEMBER_MEMORY_CONTENT = 'The user prefers terse status updates in chat.';

/** Invalid-scope candidate: parseExtractionResponse must drop it silently. */
const INVALID_MEMORY_KEY = 'invalid-scope-fact';

const EXTRACTION_JSON = JSON.stringify([
  { key: AGENT_MEMORY_KEY, content: AGENT_MEMORY_CONTENT, scope: 'agent' },
  { key: MEMBER_MEMORY_KEY, content: MEMBER_MEMORY_CONTENT, scope: 'member' },
  { key: INVALID_MEMORY_KEY, content: 'This candidate carries an invalid scope.', scope: 'global' },
]);

const SEED_MESSAGES = [
  'We are setting up the deployment pipeline for the new service.',
  'Remember that the deployment rollout requires the fluxcapacitor toggle to be enabled first.',
  'Also, I prefer terse status updates going forward.',
];

/** Every non-stopword lexeme here appears in AGENT_MEMORY_CONTENT. */
const TURN4_MESSAGE = 'Does the deployment rollout require the fluxcapacitor toggle?';

const FINAL_REPLY = 'Memory lifecycle probe complete.';

function readJsonBody(req: IncomingMessage): Promise<ChatCompletionRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatCompletionRequest);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendSse(
  res: ServerResponse,
  response:
    | { kind: 'tool'; id: string; name: string; arguments: Record<string, unknown> }
    | { kind: 'text'; text: string }
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (response.kind === 'tool') {
    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${response.id}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: response.id,
                  type: 'function',
                  function: {
                    name: response.name,
                    arguments: JSON.stringify(response.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`
    );
  } else {
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-final',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: response.text },
            finish_reason: 'stop',
          },
        ],
      })}\n\n`
    );
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    })}\n\n`
  );
  res.end('data: [DONE]\n\n');
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForSocketMessage(
  ws: WebSocket,
  predicate: (message: SocketMessage) => boolean,
  timeoutMs = 30_000
): Promise<SocketMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for matching WebSocket message'));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      const parsed = JSON.parse(raw.toString()) as SocketMessage;
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

/** First system-role message of a provider request (chat-completions shape). */
function systemText(body: ChatCompletionRequest): string {
  const first = body.messages?.[0];
  return first && first.role === 'system' && typeof first.content === 'string' ? first.content : '';
}

function messageTexts(body: ChatCompletionRequest): string[] {
  return (body.messages ?? []).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  );
}

function stringifiedMessages(body: ChatCompletionRequest): string {
  return JSON.stringify(body.messages ?? []);
}

/** The ephemeral turn-context tail message of one provider request ('' if none). */
function turnContextTail(body: ChatCompletionRequest): string {
  const tails = messageTexts(body).filter((t) => t.includes('[Turn context'));
  return tails[tails.length - 1] ?? '';
}

test.describe('memory lifecycle: compaction extraction → recall tail (isolated managed server)', () => {
  test('extracts at compaction, recalls in the next tail, never surfaces proposals', async () => {
    test.setTimeout(300_000);

    const agentTurnRequests: ChatCompletionRequest[] = [];
    const summaryRequests: ChatCompletionRequest[] = [];
    const extractionRequests: ChatCompletionRequest[] = [];
    const unexpectedRequests: ChatCompletionRequest[] = [];

    const fakeProvider = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'memory-test-model', object: 'model', owned_by: 'local' }],
          })
        );
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }

      const body = await readJsonBody(req);
      const system = systemText(body);

      // Utility calls carry no tools; discriminate by their system prompts.
      if (system.includes('You extract durable facts')) {
        extractionRequests.push(body);
        sendSse(res, { kind: 'text', text: EXTRACTION_JSON });
        return;
      }
      if (
        system.includes('You maintain the running memory') ||
        system.includes('Summarize the conversation below')
      ) {
        summaryRequests.push(body);
        sendSse(res, {
          kind: 'text',
          text:
            'The user and Quokka set up a deployment pipeline; the rollout depends on a ' +
            'feature toggle, and the user stated a preference about status updates.',
        });
        return;
      }

      if (body.tools?.length) {
        agentTurnRequests.push(body);
        const transcript = stringifiedMessages(body);
        // Turn 4 (post-compaction) is content-routed so provider retries can
        // never shift a fixed request index: probe message present → search
        // for the agent memory; first result present → search for the
        // proposal; second result present → finish.
        if (transcript.includes(TURN4_MESSAGE)) {
          if (transcript.includes('No memories found')) {
            sendSse(res, { kind: 'text', text: FINAL_REPLY });
          } else if (transcript.includes('Found 1 memor')) {
            sendSse(res, {
              kind: 'tool',
              id: 'call-search-proposal',
              name: 'memory_search',
              arguments: { query: 'terse status updates' },
            });
          } else {
            sendSse(res, {
              kind: 'tool',
              id: 'call-search-active',
              name: 'memory_search',
              arguments: { query: 'deployment rollout fluxcapacitor toggle' },
            });
          }
          return;
        }
        sendSse(res, { kind: 'text', text: `Acknowledged (${agentTurnRequests.length}).` });
        return;
      }

      unexpectedRequests.push(body);
      sendSse(res, { kind: 'text', text: 'Unexpected utility request.' });
    });

    await new Promise<void>((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
    const providerPort = (fakeProvider.address() as AddressInfo).port;
    let scratch: ScratchServer | undefined;
    let ws: WebSocket | undefined;
    const receivedTypes: string[] = [];
    let phase = 'boot';
    try {
      scratch = await ScratchServer.boot({
        timeoutMs: 90_000,
        captureLog: true,
        env: {
          SNAGLET_LM_STUDIO_URL: `http://127.0.0.1:${providerPort}/v1`,
          COMPACT_CONVERSATIONS: 'true',
          SNAGLET_LOG_FILE: 'false',
        },
      });

      // Tool sync is async after readiness — the agent needs the merged memory
      // tool in the catalog before its first turn (hasMemoryTools gates the
      // tail). The mock model calls the old id `memory_search`, which
      // exercises the alias → memory(op:search) path end to end.
      await expect
        .poll(async () => JSON.stringify(await scratch!.getData<unknown[]>('/tools')), {
          timeout: 20_000,
        })
        .toContain('"id":"memory"');

      phase = 'arrange-agent';
      // Register the fake model in the catalog with a real context window.
      // An uncataloged model falls back to the small default window, and that
      // budget makes compressMessages fold the current turn's own tool
      // exchanges (and the ephemeral turn-context tail) out of every
      // iteration after the first — the repeat-call guard then has to bail
      // the agent out. A realistic window keeps the turn append-only, like
      // production models whose windows the catalog knows.
      await scratch.query(
        `INSERT INTO models (id, provider_id, model_id, display_name, description,
                             context_window_tokens, max_output_tokens, type, is_active,
                             sort_order, metadata)
         VALUES (gen_random_uuid(), 'lm-studio', 'memory-test-model', 'Memory Test Model', '',
                 200000, 8192, 'llm', TRUE, 999, '{}'::jsonb)
         ON CONFLICT (provider_id, model_id) DO UPDATE SET
           context_window_tokens = EXCLUDED.context_window_tokens, is_active = TRUE`
      );

      // Arrange: agent on the fake provider
      const createdResponse = await fetch(`${scratch.api}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: AGENT_NAME }),
      });
      expect(createdResponse.ok).toBe(true);
      const agentId = ((await createdResponse.json()).data as { id: string }).id;
      const updatedResponse = await fetch(`${scratch.api}/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'lm-studio',
          modelId: 'memory-test-model',
          disableModelFallback: true,
        }),
      });
      expect(updatedResponse.ok).toBe(true);

      // Name the fake provider explicitly (step 2 of the resolution chain).
      // The default (require_explicit=false) would fall through to step 3 —
      // the agent's own model — but this spec drives a scripted fake provider,
      // so it pins the summarizer deliberately rather than relying on the
      // fallback.
      const overrideResponse = await fetch(
        `${scratch.api}/settings/agent/summary_model_overrides`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: { [agentId]: { providerId: 'lm-studio', modelId: 'memory-test-model' } },
          }),
        }
      );
      expect(overrideResponse.ok).toBe(true);

      phase = 'session';
      // Session + thread; subscribe to the thread channel
      ws = await openSocket(scratch.baseUrl.replace('http:', 'ws:') + '/ws');
      const received: SocketMessage[] = [];
      ws.on('message', (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as SocketMessage;
        received.push(parsed);
        receivedTypes.push(parsed.type);
      });

      const sessionCreated = waitForSocketMessage(ws, (m) => m.type === 'socket:session:created');
      ws.send(JSON.stringify({ type: 'socket:session:create', payload: { agentId } }));
      const session = (await sessionCreated).payload as {
        sessionId: string;
        threadId: string;
        title: string;
      };
      const threadId = session.threadId;
      // The thread title feeds the recall query; the memory content was
      // written to lexically cover it.
      expect(session.title).toBe(`Chat with ${AGENT_NAME}`);

      const subscribed = waitForSocketMessage(
        ws,
        (m) => m.type === 'subscribed' && m.channel === threadId
      );
      ws.send(JSON.stringify({ type: 'subscribe', channel: threadId }));
      await subscribed;

      phase = 'add-human';
      // Exactly one human member participant
      // Session-create adds only the agent; member-scope resolution demands
      // exactly one kind='user' participant, so add the boot-seeded local user.
      const users = await scratch.query<{ id: string }>(`SELECT id FROM users`);
      expect(users).toHaveLength(1);
      const addUser = await fetch(`${scratch.api}/threads/${threadId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: users[0].id }),
      });
      expect(addUser.ok).toBe(true);
      const humanCount = await scratch.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM thread_participants tp JOIN members m ON m.id = tp.member_id
          WHERE tp.thread_id = $1 AND m.kind = 'user'`,
        [threadId]
      );
      expect(humanCount[0].n).toBe(1);

      phase = 'seed-turns';
      // Seed turns
      for (const message of SEED_MESSAGES) {
        const done = waitForSocketMessage(ws, (m) => m.type === 'socket:done', 60_000);
        ws.send(
          JSON.stringify({
            type: 'socket:chat:send',
            payload: { sessionId: session.sessionId, message },
          })
        );
        await done;
      }
      expect(agentTurnRequests.length).toBe(3);

      // Negative control: no memories exist yet, so no tail block.
      const seedTail = turnContextTail(agentTurnRequests[0]);
      expect(seedTail.length).toBeGreaterThan(0);
      expect(seedTail).not.toContain('Recalled memories');

      phase = 'compact';
      // Compact: summary + extraction
      const compactComplete = waitForSocketMessage(
        ws,
        (m) => m.type === 'socket:thread:compact:complete',
        60_000
      );
      const extractionEvent = waitForSocketMessage(
        ws,
        (m) => m.type === 'socket:thread:memory-extraction',
        60_000
      );
      ws.send(
        JSON.stringify({
          type: 'socket:thread:compact',
          payload: { sessionId: session.sessionId },
        })
      );
      expect(((await compactComplete).payload as { threadId: string }).threadId).toBe(threadId);

      // The delta broadcast, with the extraction's real counts.
      // (dropped is 0, not 1: the invalid-scope candidate is discarded inside
      // parseExtractionResponse before the save loop that counts drops.)
      expect((await extractionEvent).payload).toEqual({
        threadId,
        agentId,
        saved: 1,
        proposed: 1,
        dropped: 0,
      });

      expect(summaryRequests.length).toBe(1);
      expect(extractionRequests.length).toBe(1);
      // The extraction pass really read the compacted span.
      const extractionUser = messageTexts(extractionRequests[0]).join('\n');
      expect(extractionUser).toContain('CONVERSATION SPAN');
      expect(extractionUser).toContain('fluxcapacitor');

      // (No log-line assertion here: the scratch child's stdout only carries
      // [DB]/[db] boot lines in this configuration — logger.info output does
      // not reach it. The socket event + DB rows below cover the same facts.)

      phase = 'db-assertions';
      // DB assertions (verified/status columns live on the scratch DB)
      const agentRows = await scratch.query<{
        id: string;
        agent_id: string | null;
        member_id: string | null;
        content: string;
        verified: boolean;
        status: string;
        source_thread_id: string | null;
      }>(
        `SELECT id, agent_id, member_id, content, verified, status, source_thread_id
           FROM memories WHERE memory_key = $1`,
        [AGENT_MEMORY_KEY]
      );
      expect(agentRows).toHaveLength(1);
      expect(agentRows[0]).toMatchObject({
        agent_id: agentId,
        member_id: null,
        content: AGENT_MEMORY_CONTENT,
        verified: false,
        status: 'active',
        source_thread_id: threadId,
      });

      const memberRows = await scratch.query<{
        agent_id: string | null;
        member_id: string | null;
        owner_kind: string;
        content: string;
        verified: boolean;
        status: string;
        source_thread_id: string | null;
      }>(
        `SELECT m.agent_id, m.member_id, mem.kind AS owner_kind, m.content,
                m.verified, m.status, m.source_thread_id
           FROM memories m JOIN members mem ON mem.id = m.member_id
          WHERE m.memory_key = $1`,
        [MEMBER_MEMORY_KEY]
      );
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]).toMatchObject({
        agent_id: null,
        owner_kind: 'user',
        content: MEMBER_MEMORY_CONTENT,
        verified: false,
        status: 'proposed',
        source_thread_id: threadId,
      });

      // The invalid-scope candidate must not exist under any owner.
      const invalidRows = await scratch.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM memories
          WHERE memory_key = $1 OR content LIKE '%invalid scope%'`,
        [INVALID_MEMORY_KEY]
      );
      expect(invalidRows[0].n).toBe(0);

      // Keyword-only evidence: the scratch SNAGLET_HOME has no embedder model
      // files, so the memory has NO embedding row — any later tail admission
      // can only have come through the FTS keyword arm.
      const embeddingRows = await scratch.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM embeddings WHERE node_id = $1`,
        [agentRows[0].id]
      );
      expect(embeddingRows[0].n).toBe(0);

      // Provenance links ride memoryService.store fire-and-forget — poll.
      await expect
        .poll(
          async () =>
            (
              await scratch!.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM links
                  WHERE source_id = $1 AND target_id = $2 AND relation = 'context'`,
                [agentRows[0].id, threadId]
              )
            )[0].n,
          { timeout: 10_000 }
        )
        .toBe(1);
      const summaryRows = await scratch.query<{ id: string }>(
        `SELECT id FROM thread_summaries WHERE thread_id = $1 AND agent_id = $2`,
        [threadId, agentId]
      );
      expect(summaryRows).toHaveLength(1);
      await expect
        .poll(
          async () =>
            (
              await scratch!.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM links
                  WHERE source_id = $1 AND target_id = $2 AND relation = 'context'`,
                [agentRows[0].id, summaryRows[0].id]
              )
            )[0].n,
          { timeout: 10_000 }
        )
        .toBe(1);

      phase = 'turn-4';
      // Turn 4: recall tail + memory_search surfaces
      const turn4Done = waitForSocketMessage(ws, (m) => m.type === 'socket:done', 60_000);
      ws.send(
        JSON.stringify({
          type: 'socket:chat:send',
          payload: { sessionId: session.sessionId, message: TURN4_MESSAGE },
        })
      );
      const completion = await turn4Done;
      expect(completion.payload?.reply).toContain(FINAL_REPLY);
      expect(agentTurnRequests.length).toBe(6);

      // The provider-bound ephemeral tail of the post-extraction
      // turn carries the recalled memory as a one-liner — and never the
      // proposed member fact.
      const turn4Requests = agentTurnRequests.filter((r) =>
        stringifiedMessages(r).includes(TURN4_MESSAGE)
      );
      expect(turn4Requests.length).toBe(3);
      const tail = turnContextTail(turn4Requests[0]);
      expect(tail).toContain('**Recalled memories**');
      expect(tail).toContain(AGENT_MEMORY_CONTENT);
      expect(tail).toContain(`(${AGENT_NAME}, today)`);
      expect(tail).toContain(`Chat with ${AGENT_NAME}`); // title reached the turn coords
      expect(tail).not.toContain('terse');

      // memory_search #1 (matches the active memory) → found it.
      const afterFirstSearch = turn4Requests.find((r) =>
        stringifiedMessages(r).includes('Found 1 memor')
      );
      expect(afterFirstSearch).toBeTruthy();
      const firstSearchTranscript = stringifiedMessages(afterFirstSearch!);
      expect(firstSearchTranscript).toContain(AGENT_MEMORY_KEY);

      // memory_search #2 (query lexically matches only the proposal) → the
      // proposal never surfaces: 'No memories found'.
      const afterSecondSearch = turn4Requests.find((r) =>
        stringifiedMessages(r).includes('No memories found')
      );
      expect(afterSecondSearch).toBeTruthy();
      // 'prefers terse' is unique to the proposal content (the search QUERY
      // string is 'terse status updates', which never contains 'prefers').
      expect(stringifiedMessages(afterSecondSearch!)).not.toContain('prefers terse');

      // Loop hygiene
      expect(unexpectedRequests).toHaveLength(0);
      expect(received.filter((m) => m.type === 'socket:thread:memory-extraction')).toHaveLength(1);
    } catch (error) {
      console.error(`[memory-e2e] failed in phase: ${phase}`);
      console.error(`[memory-e2e] socket types seen: ${receivedTypes.join(', ')}`);
      console.error(
        `[memory-e2e] provider counters: turns=${agentTurnRequests.length} ` +
          `summaries=${summaryRequests.length} extractions=${extractionRequests.length} ` +
          `unexpected=${unexpectedRequests.length}`
      );
      console.error(
        `[memory-e2e] server log tail:\n${scratch?.logTail().slice(-6000) ?? '(none)'}`
      );
      for (const [i, r] of agentTurnRequests.entries()) {
        const nonSystem = (r.messages ?? [])
          .filter((m) => m.role !== 'system')
          .map((m) => {
            const content =
              typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
            const calls = m.tool_calls ? ` tool_calls=${JSON.stringify(m.tool_calls)}` : '';
            return `    [${m.role}]${calls} ${content.slice(0, 220).replace(/\n/g, ' | ')}`;
          })
          .join('\n');
        console.error(`[memory-e2e] provider request #${i + 1} messages:\n${nonSystem}`);
      }
      throw error;
    } finally {
      ws?.close();
      await scratch?.dispose();
      await new Promise<void>((resolve, reject) => {
        fakeProvider.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
