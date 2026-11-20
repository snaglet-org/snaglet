import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ScratchServer } from './helpers/scratchServer';

interface ToolWireDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  tools?: ToolWireDefinition[];
}

interface SocketMessage {
  type: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

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

test.describe('progressive tool disclosure (isolated managed server)', () => {
  test('discovers Gmail, fetches its schema, and calls it through action without growing the catalog', async () => {
    test.setTimeout(120_000);

    const catalogRequests: ChatCompletionRequest[] = [];
    const fakeProvider = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'catalog-test-model', object: 'model', owned_by: 'local' }],
          })
        );
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }

      const body = await readJsonBody(req);
      if (!body.tools?.length) {
        sendSse(res, { kind: 'text', text: 'Progressive disclosure smoke' });
        return;
      }
      catalogRequests.push(body);
      const requestNumber = catalogRequests.length;
      if (requestNumber === 1) {
        sendSse(res, {
          kind: 'tool',
          id: 'call-search',
          name: 'search_tools',
          arguments: { query: 'send an email', mode: 'keyword' },
        });
      } else if (requestNumber === 2) {
        sendSse(res, {
          kind: 'tool',
          id: 'call-schema',
          name: 'get_tool_schema',
          arguments: { tool: 'google_gmail' },
        });
      } else if (requestNumber === 3) {
        // The fetched tool is not advertised; it is reached through the gateway.
        sendSse(res, {
          kind: 'tool',
          id: 'call-gmail',
          name: 'action',
          arguments: {
            tool: 'google_gmail',
            params: {
              operation: 'send',
              to: 'alice@example.com',
              subject: 'Progressive disclosure smoke',
              body: 'Hello from the isolated Snaglet catalog test.',
            },
          },
        });
      } else {
        sendSse(res, {
          kind: 'text',
          text: 'The Gmail operation was attempted through the discovered capability.',
        });
      }
    });

    await new Promise<void>((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
    const providerPort = (fakeProvider.address() as AddressInfo).port;
    let scratch: ScratchServer | undefined;
    let ws: WebSocket | undefined;
    try {
      scratch = await ScratchServer.boot({
        timeoutMs: 60_000,
        captureLog: true,
        env: {
          SNAGLET_LM_STUDIO_URL: `http://127.0.0.1:${providerPort}/v1`,
          SNAGLET_DEBUG_TOOL_CATALOG_METRICS: '1',
          SNAGLET_LOG_FILE: 'false',
          // The log assertions below match logger.info lines; a worktree .env
          // with LOG_LEVEL=error (inherited through the playwright process)
          // would silently suppress them, so pin the level the spec needs.
          LOG_LEVEL: 'info',
        },
      });
      // Wait for completed boot sync rather than pinning an unrelated catalog
      // count (adding a built-in tool must not stall the disclosure scenario).
      await scratch.waitForLog(/Tool registry synced to DB: \d+ tools/);

      // Availability only requires a provider credential row. The deliberately
      // invalid encrypted payload makes the real Gmail handler stop locally,
      // after dispatch but before any network request or real email can occur.
      await scratch.query(
        `INSERT INTO user_provider_credentials
           (id, provider_id, auth_type_id, auth_type, label, encrypted_secret, metadata_json)
         VALUES ($1, 'google-workspace', 'google-workspace:oauth', 'oauth', $2, $3, '{}'::jsonb)`,
        ['catalog-e2e-google', 'Catalog E2E (non-routable)', 'invalid-test-ciphertext']
      );

      const createdResponse = await fetch(`${scratch.api}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Catalog Disclosure Probe' }),
      });
      expect(createdResponse.ok).toBe(true);
      const created = (await createdResponse.json()).data as { id: string };
      const updatedResponse = await fetch(`${scratch.api}/agents/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'lm-studio',
          modelId: 'catalog-test-model',
          disableModelFallback: true,
        }),
      });
      expect(updatedResponse.ok).toBe(true);

      ws = await openSocket(scratch.baseUrl.replace('http:', 'ws:') + '/ws');
      const sessionCreated = waitForSocketMessage(ws, (message) => {
        return message.type === 'socket:session:created';
      });
      ws.send(
        JSON.stringify({
          type: 'socket:session:create',
          payload: { agentId: created.id },
        })
      );
      const session = (await sessionCreated).payload as {
        sessionId: string;
        threadId: string;
      };

      const subscribed = waitForSocketMessage(
        ws,
        (message) => message.type === 'subscribed' && message.channel === session.threadId
      );
      ws.send(JSON.stringify({ type: 'subscribe', channel: session.threadId }));
      await subscribed;

      // New agents guard destructive tools by default: the first
      // google_gmail call parks the run on a human confirmation. Act as that
      // human — record the request (pinning the guard) and approve it so the
      // disclosure flow completes.
      const confirmationRequests: SocketMessage[] = [];
      const socket = ws;
      socket.on('message', (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as SocketMessage;
        if (parsed.type !== 'socket:tool:confirmation_request') return;
        confirmationRequests.push(parsed);
        socket.send(
          JSON.stringify({
            type: 'socket:tool:confirm',
            payload: {
              sessionId: session.sessionId,
              callId: (parsed.payload as { callId?: string })?.callId,
              decision: 'approve_once',
            },
          })
        );
      });

      const done = waitForSocketMessage(ws, (message) => message.type === 'socket:done', 60_000);
      ws.send(
        JSON.stringify({
          type: 'socket:chat:send',
          payload: {
            sessionId: session.sessionId,
            message: 'Email alice@example.com a short hello.',
          },
        })
      );
      let completion: SocketMessage;
      try {
        completion = await done;
      } catch (error) {
        // Surface the scratch server's log with the timeout — a silent stall
        // in dispatch is undebuggable from the socket side alone.
        console.error('[tpd] socket:done timeout; scratch log tail:\n', scratch.logTail());
        throw error;
      }
      expect(completion.payload?.reply).toContain('attempted through the discovered capability');

      // The guarded-by-default contract: the fresh agent's google_gmail call
      // required exactly one human approval before executing.
      expect(
        confirmationRequests.map((message) => (message.payload as { toolName?: string })?.toolName)
      ).toEqual(['google_gmail']);

      expect(catalogRequests).toHaveLength(4);
      const toolNames = (index: number): string[] =>
        (catalogRequests[index]?.tools ?? []).map((tool) => tool.function.name);
      // The advertised catalog is identical on every request of the run, so
      // the cached prefix is never rewritten by a schema lookup.
      expect(toolNames(0)).toContain('action');
      expect(toolNames(0)).not.toContain('google_gmail');
      for (let index = 1; index < catalogRequests.length; index += 1) {
        expect(toolNames(index)).toEqual(toolNames(0));
      }

      const activity = await scratch.query<{ tool: string; tool_output: unknown }>(
        `SELECT tool, tool_output
           FROM agent_activity_log
          WHERE agent_id = $1 AND action_type = 'tool_call'
          ORDER BY created_at ASC`,
        [created.id]
      );
      // A gateway call is logged as action__<tool>.
      expect(activity.map((row) => row.tool)).toEqual([
        'search_tools',
        'get_tool_schema',
        'action__google_gmail',
      ]);
      expect(JSON.stringify(activity[0]?.tool_output)).toContain('google_gmail');
      expect(JSON.stringify(activity[1]?.tool_output)).toContain('google_gmail');
      expect(JSON.stringify(activity[1]?.tool_output)).toContain('call_with');
      expect(JSON.stringify(activity[2]?.tool_output)).toMatch(/decrypt|invalid|cipher/i);

      expect(scratch.logTail()).not.toMatch(/tool-catalog-expansion|cache_rebuild=true/);
      // serialized_bytes is the exact JSON.stringify of the advertised catalog,
      // so any edit to a core tool's description or schema moves it — recompute
      // rather than nudge it. measureAnthropicToolCatalog (ToolFormatService) is
      // the whole calculation: feed it the CORE_TOOL_IDS rows and read the two
      // numbers back. estimated_tokens is just ceil(bytes / 4).
      expect(scratch.logTail()).toMatch(
        /tool-catalog-metrics.*tools=21.*serialized_bytes=39902.*estimated_tokens=9976/
      );
    } finally {
      ws?.close();
      await scratch?.dispose();
      await new Promise<void>((resolve, reject) => {
        fakeProvider.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
