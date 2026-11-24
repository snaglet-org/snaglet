/**
 * A Trusted agent with the deny rule `shell(rm -rf:*)` is refused a chained
 * delete, with no approval prompt and nothing run, against the real database,
 * tool catalog, resolver, chat dispatch (dispatchToolCalls) and shell
 * executor; and on POST /api/tools/execute (scripts, hooks). This is the shape
 * of the run that once deleted a folder: one shell call that lists, deletes
 * and checks. A control call proves the same path really runs commands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

// The only stand-in: if dispatch ever asked, the stub would approve and the
// command would run, so "not called" and "folder still there" both matter.
jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: jest.fn(async () => ({ approved: true, timedOut: false })),
}));

import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import express from 'express';
import request from 'supertest';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { Agents, Threads, closeDatabase } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import { getPanelToken, toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';
import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { agentService } from '@server/services/AgentService';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { waitForConfirmation } from '@server/services/SocketService/confirmation';
import {
  dispatchToolCalls,
  type DispatchToolCallsInput,
} from '@server/services/SocketService/handlers/chatPhases/toolDispatch';

const RULE = 'shell(rm -rf:*)';
const THREAD_ID = 'thread-1111111111111-denychain';
const asked = waitForConfirmation as jest.MockedFunction<typeof waitForConfirmation>;

let agentId = '';
let root = '';
let scratch = '';

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false
  );

async function setAccess(mode: ToolAccessConfig['mode'], denyList: string[]): Promise<void> {
  await Agents.update(agentId, { toolAccessMode: mode, toolAccessDenyList: denyList });
}

/** One shell call through chat dispatch, as the agent's own turn makes it. */
async function dispatchShell(cmd: string): Promise<string> {
  const agent = (await agentService.get(agentId))!;
  const tools = await resolveAgentTools(agentId);
  const toolMap = new Map(tools.map((t) => [t.tool.id, t]));
  // The access a turn hands dispatch (contextAssembly reads the agent row).
  const toolAccess: ToolAccessConfig = {
    mode: agent.toolAccessMode ?? 'all',
    allowList: agent.toolAccessAllowList ?? [],
    denyList: agent.toolAccessDenyList ?? [],
  };
  const input: DispatchToolCallsInput = {
    result: {
      reply: '',
      toolCalls: [{ id: 'call-1', name: 'shell', input: { op: 'run', cmd, workdir: scratch } }],
    },
    agent,
    runtimeAgent: agent,
    agentMessages: [],
    toolMap,
    visibleToolIds: new Set(toolMap.keys()),
    toolAccess,
    session: { threadId: THREAD_ID, id: 'session-1' } as DispatchToolCallsInput['session'],
    sessionId: 'session-1',
    threadName: 'Deny rules',
    runId: null,
    triggerMessageId: undefined,
    latestThinking: '',
    toToolText: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
    dispatchMode: 'all',
  };
  await dispatchToolCalls(input);
  const message = input.agentMessages[0] as { content: Array<{ content: unknown }> };
  return String(message.content[0]!.content);
}

describe('a Trusted agent with shell(rm -rf:*) (real dispatch and shell)', () => {
  let target = '';
  let keep = '';

  beforeAll(async () => {
    await toolRegistry.load();
    const sync = await toolRegistry.syncToDatabase();
    expect(sync.errors).toEqual([]);
    // Created the way the app creates agents (guarded by default), then
    // switched to Trusted mode.
    const agent = await agentService.create({ name: 'Sally Deny Test', role: 'test' });
    agentId = agent.id;
    await Agents.update(agentId, { trustedToolCalls: true });
    await Threads.create({ id: THREAD_ID, title: 'Deny rules' });
    root = await mkdtemp(path.join(os.tmpdir(), 'snaglet-deny-chained-'));
  }, 60_000);

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(root, 'case-'));
    target = path.join(scratch, 'sally-scratch');
    keep = path.join(target, 'keep.txt');
    await mkdir(target);
    await writeFile(keep, 'still here\n');
    asked.mockClear();
    await setAccess('deny_list', [RULE]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDatabase();
  });

  it('runs a permitted command without asking (the path really executes)', async () => {
    const tools = await resolveAgentTools(agentId);
    expect(tools.find((t) => t.tool.id === 'shell')?.requiresConfirmation).toBe(false);

    const marker = path.join(scratch, 'ran.txt');
    const output = await dispatchShell(`touch ${marker}; ls ${target}`);
    expect(output).toContain('keep.txt');
    expect(await exists(marker)).toBe(true);
    expect(asked).not.toHaveBeenCalled();
  });

  it.each([
    ['the reported shape', (t: string) => `ls -la ${t}; rm -rf ${t}; ls ${t}`],
    ['after cd &&', (t: string) => `cd ${path.dirname(t)} && rm -rf ${path.basename(t)}`],
    ['flags reordered, by path', (t: string) => `/bin/rm -fr ${t}`],
    ['inside sh -c', (t: string) => `sh -c 'echo cleaning; rm -r -f ${t}'`],
  ])('refuses %s with no prompt, and the folder survives', async (_label, build) => {
    const cmd = build(target);
    const output = await dispatchShell(cmd);
    expect(output).toContain('Blocked by tool-access policy');
    expect(output).toContain(`matches deny rule ${RULE}`);
    expect(asked).not.toHaveBeenCalled();
    expect(await exists(keep)).toBe(true);
  });

  it('names the command in the chain that matched', async () => {
    const output = await dispatchShell(`ls -la ${target}; rm -rf ${target}; ls ${target}`);
    expect(output).toContain(`runs \`rm -rf ${target}\`, which matches deny rule ${RULE}`);
  });

  it('refuses a line it cannot check, with the reason, and the folder survives', async () => {
    const output = await dispatchShell(`X=rm; $X -rf ${target}`);
    expect(output).toContain(`this command could not be checked against deny rule ${RULE}`);
    expect(output).toContain('its program `$X` is only known when it runs');
    expect(asked).not.toHaveBeenCalled();
    expect(await exists(keep)).toBe(true);
  });

  it('refuses it in All mode too: the deny list applies in every mode', async () => {
    await setAccess('all', [RULE]);
    const output = await dispatchShell(`ls ${target}; rm -rf ${target}`);
    expect(output).toContain(`matches deny rule ${RULE}`);
    expect(asked).not.toHaveBeenCalled();
    expect(await exists(keep)).toBe(true);
  });

  it('refuses it on POST /api/tools/execute (scripts, hooks)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
    app.use(errorHandler);
    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({
        name: 'shell',
        input: { op: 'run', cmd: `ls ${target}; rm -rf ${target}`, workdir: scratch },
        agent_id: agentId,
      });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`matches deny rule ${RULE}`);
    expect(await exists(keep)).toBe(true);
  });
});
