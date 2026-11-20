jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    // Real agent rows are camelCase (cursorFlower / cursorColor).
    findById: jest.fn(async (id: string) => ({
      id,
      name: id === 'test-agent-a' ? 'Test User' : 'Other User',
      cursorFlower: id === 'test-agent-a' ? 'sunflower' : null,
      cursorColor: id === 'test-agent-a' ? '#112233' : null,
    })),
  },
}));
jest.mock('@snaglet/db/tables/images', () => ({ Images: {} }));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  snapshotFromImage: jest.fn(),
}));
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: jest.fn(),
}));
jest.mock('@server/services/WebSocketService', () => ({ wsService: { broadcast: jest.fn() } }));

process.env.SNAGLET_COMPUTER_REQUIRE_APPROVAL = '0';
import tool, { emitEmotionCursor } from '@server/services/ToolService/tools/system/computer/tool';
import { cursorClaimService } from '@server/services/CursorClaimService';

const run = async (agentId: string, input: Record<string, unknown>) =>
  JSON.parse((await tool(input, {}, { agentId } as never)) as string);

describe('computer tool', () => {
  const orig = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: orig }));
  beforeEach(() => cursorClaimService.revoke());

  it('returns the busy reply to a non-holder', async () => {
    expect((await run('test-agent-a', { op: 'claim' })).ok).toBe(true);
    const r = await run('test-agent-b', { op: 'move', x: 5, y: 5 });
    expect(r).toMatchObject({ ok: false, busy: true, holder: 'Test User' });
  });

  it('draws the cursor with the flower and color the agent picked', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    wsService.broadcast.mockClear();
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run('test-agent-a', { op: 'claim' });
    await run('test-agent-a', { op: 'move', x: 5, y: 5 });
    const events = wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m: { type: string }) => m.type === 'agent:cursor');
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].payload).toMatchObject({
      flower: 'sunflower',
      color: '#112233',
    });
  });

  it('flags cursor events systemOverlay only while the system overlay is alive', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    const overlay = await import('@server/services/systemCursorOverlay');
    const last = () => {
      const evs = wsService.broadcast.mock.calls
        .map(([m]) => m)
        .filter((m: { type: string }) => m.type === 'agent:cursor');
      return evs[evs.length - 1].payload;
    };
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    overlay.resetSystemOverlay();
    await run('test-agent-a', { op: 'claim' });
    await run('test-agent-a', { op: 'move', x: 5, y: 5 });
    expect(last().systemOverlay).toBeUndefined();
    overlay.markSystemOverlayAlive();
    await run('test-agent-a', { op: 'move', x: 6, y: 6 });
    expect(last().systemOverlay).toBe(true);
    overlay.resetSystemOverlay();
  });

  it('shows no stumped flower for a failure before the agent has any position', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    wsService.broadcast.mockClear();
    // No claim and no known position: the op fails, and nothing is drawn in the corner.
    const reply = await run('test-agent-never-seen', { op: 'type', text: 'x' });
    expect(reply.ok).toBe(false);
    const withEmotion = wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter(
        (m: { type: string; payload?: { emotion?: string } }) =>
          m.type === 'agent:cursor' && m.payload?.emotion
      );
    expect(withEmotion).toHaveLength(0);
  });

  it('emitEmotionCursor draws an idle event with the emotion at the last position, none without one', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    const emitted = () =>
      wsService.broadcast.mock.calls
        .map(([m]) => m)
        .filter((m: { type: string }) => m.type === 'agent:cursor');
    wsService.broadcast.mockClear();
    await emitEmotionCursor('test-agent-never-seen-2', 'curious', 'Which one?');
    expect(emitted()).toHaveLength(0);
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run('test-agent-a', { op: 'claim' });
    await run('test-agent-a', { op: 'move', x: 7, y: 9 });
    wsService.broadcast.mockClear();
    await emitEmotionCursor('test-agent-a', 'curious', 'Which one?', 'start');
    await emitEmotionCursor('test-agent-a', 'neutral', undefined, 'settle');
    const [a, b] = emitted().map((m: { payload: unknown }) => m.payload);
    expect(a).toMatchObject({
      agentId: 'test-agent-a',
      state: 'idle',
      x: 7,
      y: 9,
      label: 'Which one?',
      emotion: 'curious',
      emotionUpdate: 'start',
    });
    expect(b).toMatchObject({ state: 'idle', emotion: 'neutral', emotionUpdate: 'settle' });
    expect(b.label).toBeUndefined();
  });

  it('emitEmotionCursor never redraws the flower once the claim is released, revoked or lapsed', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    const emitted = () =>
      wsService.broadcast.mock.calls
        .map(([m]) => m)
        .filter((m: { type: string }) => m.type === 'agent:cursor');
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;

    // Released by the agent.
    await run('test-agent-a', { op: 'claim' });
    await run('test-agent-a', { op: 'move', x: 7, y: 9 });
    await run('test-agent-a', { op: 'release' });
    wsService.broadcast.mockClear();
    await emitEmotionCursor('test-agent-a', 'curious', 'Should the team organize?');
    await emitEmotionCursor('test-agent-a', 'thinking');
    expect(emitted()).toHaveLength(0);

    // Revoked (Esc / kill switch) or lapsed lease: no holder any more.
    await run('test-agent-a', { op: 'claim' });
    await run('test-agent-a', { op: 'move', x: 7, y: 9 });
    cursorClaimService.revoke();
    wsService.broadcast.mockClear();
    await emitEmotionCursor('test-agent-a', 'curious', 'Still there?');
    expect(emitted()).toHaveLength(0);

    // A fresh claim without a new position stays hidden too: the earlier spot is forgotten.
    await run('test-agent-a', { op: 'claim' });
    wsService.broadcast.mockClear();
    await emitEmotionCursor('test-agent-a', 'curious', 'Again?');
    expect(emitted()).toHaveLength(0);
  });

  it('point draws several agents at once without the claim, even while another holds it', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    await run('test-agent-a', { op: 'claim' });
    wsService.broadcast.mockClear();
    const r = await run('test-agent-b', { op: 'point', x: 400, y: 300, reason: 'stale label' });
    expect(r).toMatchObject({ ok: true, pointed: { x: 400, y: 300 }, holder: 'Test User' });
    await run('test-agent-c', { op: 'point', x: 900, y: 120, reason: 'no start-here view' });
    const payloads = wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m: { type: string }) => m.type === 'agent:cursor')
      .map((m: { payload: { agentId: string; x: number; label?: string } }) => m.payload);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'test-agent-b', x: 400, label: 'stale label' }),
        expect.objectContaining({ agentId: 'test-agent-c', x: 900, label: 'no start-here view' }),
      ])
    );
    // Pointing never takes or steals the real cursor.
    expect(cursorClaimService.holderAgentId()).toBe('test-agent-a');
  });

  it('point rejects missing coordinates and sends no real input', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    const r = await run('test-agent-b', { op: 'point', reason: 'here' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/numeric x and y/);
    const ok = await run('test-agent-b', { op: 'point', x: 1, y: 2 });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.simulated).toBeUndefined();
    expect(ok.interrupted).toBeUndefined();
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
  });

  it('simulates move for the holder when input is disabled', async () => {
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run('test-agent-a', { op: 'claim' });
    expect(await run('test-agent-a', { op: 'move', x: 5, y: 5 })).toMatchObject({
      ok: true,
      simulated: true,
    });
  });
});

describe('computer tool actions', () => {
  const orig = process.platform;
  const { deps, MAX_WAIT_MS } = jest.requireActual(
    '@server/services/ToolService/tools/system/computer/tool'
  ) as typeof import('@server/services/ToolService/tools/system/computer/tool');
  const origRun = deps.runJxa;
  const origSleep = deps.sleep;
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  let elements: Array<Record<string, unknown>> = [];
  let focus: Record<string, unknown> = { role: 'AXTextField', subrole: '', label: 'Notes' };
  let front = 'Notes';

  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: orig });
    deps.runJxa = origRun;
    deps.sleep = origSleep;
  });
  beforeEach(() => {
    cursorClaimService.revoke();
    calls.length = 0;
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    delete process.env.SNAGLET_COMPUTER_ALLOWED_APPS;
    front = 'Notes';
    focus = { role: 'AXTextField', subrole: '', label: 'Notes' };
    elements = [
      {
        path: [0],
        role: 'AXButton',
        subrole: '',
        label: 'Send',
        value: '',
        x: 10,
        y: 10,
        w: 20,
        h: 20,
      },
      {
        path: [1],
        role: 'AXButton',
        subrole: '',
        label: 'Open',
        value: '',
        x: 100,
        y: 10,
        w: 20,
        h: 20,
      },
      {
        path: [2],
        role: 'AXTextField',
        subrole: 'AXSecureTextField',
        label: 'Field',
        value: 'x',
        x: 10,
        y: 60,
        w: 50,
        h: 20,
      },
    ];
    deps.sleep = jest.fn(async () => {});
    deps.runJxa = jest.fn(async (_s: string, args: string[]) => {
      const a = JSON.parse(args[1] ?? '{}');
      calls.push({ action: args[0], args: a });
      if (args[0] === 'front') return { ok: true, app: front, title: '' };
      if (args[0] === 'focus') return { ok: true, app: front, ...focus };
      if (args[0] === 'look') return { ok: true, app: front, title: 'W', elements };
      return { ok: true };
    }) as never;
  });

  const claim = () => run('test-agent-a', { op: 'claim' });

  it('gates dangerous controls until approved', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    await claim();
    await run('test-agent-a', { op: 'look' });
    const r = await run('test-agent-a', { op: 'click', target: 'e1' });
    expect(r).toMatchObject({ ok: false, needsApproval: true });
    expect(calls.some((c) => c.action === 'click')).toBe(false);
    const ok = await run('test-agent-a', { op: 'click', target: 'e1', approved: true });
    expect(ok).toMatchObject({ ok: true, simulated: false });
    const act = await run('test-agent-a', { op: 'act', target: 'e1', action: 'press' });
    expect(act.needsApproval).toBe(true);
    expect(await run('test-agent-a', { op: 'act', target: 'e2', action: 'press' })).toMatchObject({
      ok: true,
    });
  });

  it('gates Enter, trailing newline and drag when the focused or dragged control is dangerous', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    await claim();
    await run('test-agent-a', { op: 'look' });

    focus = { role: 'AXButton', subrole: '', label: 'Send' };
    for (const input of [
      { op: 'key', combo: 'return' },
      { op: 'key', combo: 'cmd+return' },
      { op: 'type', text: 'hello\n' },
    ]) {
      expect(await run('test-agent-a', input)).toMatchObject({ ok: false, needsApproval: true });
    }
    expect(calls.some((c) => c.action === 'key' || c.action === 'type')).toBe(false);
    expect(await run('test-agent-a', { op: 'key', combo: 'enter', approved: true })).toMatchObject({
      ok: true,
    });

    // Ordinary typing and non-commit keys stay ungated even on a dangerous focus.
    expect(await run('test-agent-a', { op: 'type', text: 'hello' })).toMatchObject({ ok: true });
    expect(await run('test-agent-a', { op: 'key', combo: 'cmd+a' })).toMatchObject({ ok: true });
    // Enter in a harmless context is fine.
    focus = { role: 'AXTextField', subrole: '', label: 'Notes' };
    expect(await run('test-agent-a', { op: 'key', combo: 'return' })).toMatchObject({ ok: true });

    // e1 is the Send button, e2 is harmless.
    expect(await run('test-agent-a', { op: 'drag', from: 'e2', to: 'e1' })).toMatchObject({
      needsApproval: true,
    });
    expect(calls.some((c) => c.action === 'drag')).toBe(false);
    expect(
      await run('test-agent-a', { op: 'drag', from: 'e2', to: 'e1', approved: true })
    ).toMatchObject({ ok: true });
  });

  it('refuses a raw-coordinate click with no look on record when input is real', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    cursorClaimService.revoke();
    await run('test-agent-fresh', { op: 'claim' });
    const r = await run('test-agent-fresh', { op: 'click', x: 40, y: 40 });
    expect(r).toMatchObject({ ok: false });
    expect(String(r.error)).toContain('look first');
    expect(calls.some((c) => c.action === 'click')).toBe(false);
  });

  it('refuses secure fields for act set_value and type', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    await claim();
    await run('test-agent-a', { op: 'look' });
    const r = await run('test-agent-a', {
      op: 'act',
      target: 'e3',
      action: 'set_value',
      value: 'x',
    });
    expect(r.ok).toBe(false);
    focus = { role: 'AXTextField', subrole: 'AXSecureTextField', label: '' };
    expect((await run('test-agent-a', { op: 'type', text: 'hi' })).ok).toBe(false);
    focus = { role: 'AXTextField', subrole: '', label: 'API key' };
    expect((await run('test-agent-a', { op: 'key', combo: 'enter' })).ok).toBe(false);
    expect(calls.some((c) => c.action === 'type' || c.action === 'key' || c.action === 'act')).toBe(
      false
    );
  });

  it('refuses when the frontmost app is not allowlisted', async () => {
    process.env.SNAGLET_COMPUTER_ALLOWED_APPS = 'Calendar, Finder';
    await claim();
    const r = await run('test-agent-a', { op: 'click', x: 5, y: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the allowed list/);
    front = 'finder';
    expect((await run('test-agent-a', { op: 'click', x: 5, y: 5 })).ok).toBe(true);
  });

  it('simulates drag, scroll, type and key without touching the machine', async () => {
    await claim();
    for (const input of [
      { op: 'drag', from: { x: 1, y: 1 }, to: { x: 50, y: 50 } },
      { op: 'scroll', dy: 3 },
      { op: 'type', text: 'hello' },
      { op: 'key', combo: 'cmd+s' },
    ]) {
      expect(await run('test-agent-a', input)).toMatchObject({ ok: true, simulated: true });
    }
    expect(calls).toHaveLength(0);
  });

  it('runs real drag and key when input is enabled', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    await claim();
    await run('test-agent-a', { op: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    await run('test-agent-a', { op: 'key', combo: 'cmd+s' });
    expect(calls.find((c) => c.action === 'drag')?.args).toMatchObject({
      fx: 1,
      fy: 2,
      tx: 3,
      ty: 4,
    });
    expect(calls.find((c) => c.action === 'key')?.args).toEqual({ combo: 'cmd+s' });
  });

  it('caps wait at 10s', async () => {
    const r = await run('test-agent-a', { op: 'wait', ms: 999999 });
    expect(r).toMatchObject({ ok: true, waitedMs: MAX_WAIT_MS, capped: true });
    expect(deps.sleep).toHaveBeenCalledWith(MAX_WAIT_MS);
  });

  it('refuses look, screenshot and act without the claim (reading the screen needs consent)', async () => {
    for (const body of [
      { op: 'look' },
      { op: 'screenshot' },
      { op: 'act', action: 'press', target: 'e1' },
    ]) {
      const r = await run('test-agent-a', body);
      expect(r).toMatchObject({ ok: false });
      expect(String(r.error)).toMatch(/claim/);
    }
    expect(deps.runJxa).not.toHaveBeenCalled();
  });

  it('refuses look and screenshot while another agent holds the cursor', async () => {
    await cursorClaimService.claim('test-agent-b', 'Other User');
    expect(await run('test-agent-a', { op: 'look' })).toMatchObject({ ok: false, busy: true });
    expect(await run('test-agent-a', { op: 'screenshot' })).toMatchObject({
      ok: false,
      busy: true,
    });
    expect(deps.runJxa).not.toHaveBeenCalled();
  });

  it('caps the look tree at 150 elements', async () => {
    elements = Array.from({ length: 400 }, (_, i) => ({
      path: [i],
      role: 'AXButton',
      subrole: '',
      label: `Item ${i}`,
      value: '',
      x: i,
      y: 0,
      w: 5,
      h: 5,
    }));
    await claim();
    const r = await run('test-agent-a', { op: 'look' });
    expect(r.elements).toHaveLength(150);
    expect(r.truncated).toBe(true);
    expect(r.elements[0].id).toBe('e1');
  });

  it('reports missing Accessibility permission without crashing', async () => {
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    await claim();
    deps.runJxa = (async () => ({ ok: false, error: 'accessibility_permission_missing' })) as never;
    const r = await run('test-agent-a', { op: 'scroll', dy: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Accessibility permission/);
  });
});

describe('computer tool claim approval', () => {
  const orig = process.platform;
  const { cursorApprovalService } = jest.requireActual(
    '@server/services/CursorApprovalService'
  ) as typeof import('@server/services/CursorApprovalService');
  const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
    wsService: { broadcast: jest.Mock };
  };
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SNAGLET_COMPUTER_REQUIRE_APPROVAL;
  });
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: orig });
    process.env.SNAGLET_COMPUTER_REQUIRE_APPROVAL = '0';
  });
  beforeEach(() => {
    cursorApprovalService.revokeAll();
    cursorClaimService.revoke();
    wsService.broadcast.mockClear();
  });
  const lastReqId = () => {
    const call = wsService.broadcast.mock.calls
      .map((c) => c[0])
      .reverse()
      .find((m) => m.type === 'agent:cursor-request');
    return call.payload.requestId as string;
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it('allow proceeds to claim; deny replies denied; busy stays first', async () => {
    const p = run('test-agent-a', { op: 'claim' });
    await tick();
    cursorApprovalService.resolveApproval(lastReqId(), 'allow');
    expect(await p).toMatchObject({ ok: true, holder: 'you' });
    cursorClaimService.revoke();

    const d = run('test-agent-a', { op: 'claim' });
    await tick();
    cursorApprovalService.resolveApproval(lastReqId(), 'deny');
    expect(await d).toMatchObject({ ok: false, denied: true });

    await cursorClaimService.claim('test-agent-b', 'Other User');
    expect(await run('test-agent-a', { op: 'claim' })).toMatchObject({ busy: true });
  });

  it('session grant skips the next prompt and shows in status; stop clears it', async () => {
    const p = run('test-agent-a', { op: 'claim' });
    await tick();
    cursorApprovalService.resolveApproval(lastReqId(), 'allow-session');
    await p;
    cursorClaimService.revoke();
    wsService.broadcast.mockClear();
    expect(await run('test-agent-a', { op: 'claim' })).toMatchObject({ ok: true });
    expect(wsService.broadcast.mock.calls.some((c) => c[0].type === 'agent:cursor-request')).toBe(
      false
    );
    const st = await run('test-agent-a', { op: 'status' });
    expect(st.sessionGrants[0].agentId).toBe('test-agent-a');
    cursorApprovalService.revokeAll();
    expect((await run('test-agent-a', { op: 'status' })).sessionGrants).toEqual([]);
  });

  it('timeout replies timedOut', async () => {
    process.env.SNAGLET_COMPUTER_APPROVAL_TIMEOUT_MS = '20';
    const r = await run('test-agent-a', { op: 'claim' });
    delete process.env.SNAGLET_COMPUTER_APPROVAL_TIMEOUT_MS;
    expect(r).toMatchObject({ ok: false, timedOut: true });
  });
});

describe('computer tool mouse takeover', () => {
  const orig = process.platform;
  const { deps } = jest.requireActual(
    '@server/services/ToolService/tools/system/computer/tool'
  ) as typeof import('@server/services/ToolService/tools/system/computer/tool');
  const { POINTER_JXA } = jest.requireActual(
    '@server/services/ToolService/tools/system/computer/pointerScript'
  ) as typeof import('@server/services/ToolService/tools/system/computer/pointerScript');
  const origRun = deps.runJxa;
  let pointer: Record<string, unknown>;
  let ran: string[];
  let now: number;
  let nowSpy: jest.SpyInstance;
  const agent = 'test-agent-a';

  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: orig });
    deps.runJxa = origRun;
  });
  beforeEach(() => {
    cursorClaimService.revoke();
    delete process.env.SNAGLET_COMPUTER_ALLOWED_APPS;
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    ran = [];
    pointer = { ok: true, x: 100, y: 100 };
    deps.runJxa = jest.fn(async (script: string, args: string[]) => {
      if (script === POINTER_JXA) return pointer;
      ran.push(args[0]);
      if (args[0] === 'look') return { ok: true, app: 'Notes', title: '', elements: [] };
      if (args[0] === 'focus') return { ok: true, role: 'AXTextField', subrole: '', label: 'n' };
      return { ok: true };
    }) as never;
  });
  afterEach(() => {
    nowSpy.mockRestore();
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
  });

  it('shows the avatar at the real pointer the moment the cursor is claimed', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    wsService.broadcast.mockClear();
    pointer = { ok: true, x: 321, y: 123 };
    const reply = JSON.parse(
      (await tool({ op: 'claim', reason: 'start' }, {}, { agentId: agent } as never)) as string
    );
    expect(reply.ok).toBe(true);
    const events = wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m: { type: string }) => m.type === 'agent:cursor');
    expect(events[events.length - 1].payload).toMatchObject({ x: 321, y: 123, state: 'idle' });
  });

  it('falls back to the last known spot when the pointer cannot be read', async () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    wsService.broadcast.mockClear();
    pointer = { ok: false, error: 'nope' };
    const reply = JSON.parse(
      (await tool({ op: 'claim', reason: 'start' }, {}, { agentId: agent } as never)) as string
    );
    expect(reply.ok).toBe(true);
    const events = wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m: { type: string }) => m.type === 'agent:cursor');
    expect(events.length).toBeGreaterThan(0);
  });

  const setup = async () => {
    await run(agent, { op: 'claim' });
    await run(agent, { op: 'look' });
    expect(await run(agent, { op: 'move', x: 100, y: 100 })).toMatchObject({ ok: true });
  };

  it('never blocks the first op after a fresh claim', async () => {
    pointer = { ok: true, x: 900, y: 900 };
    await run(agent, { op: 'claim' });
    expect(await run(agent, { op: 'move', x: 5, y: 5 })).toMatchObject({ ok: true });
  });

  it('proceeds when the pointer is where the tool left it', async () => {
    await setup();
    pointer = { ok: true, x: 105, y: 105 };
    expect(await run(agent, { op: 'move', x: 200, y: 200 })).toMatchObject({ ok: true });
  });

  it('interrupts, releases and skips the op when the user moved the mouse', async () => {
    await setup();
    pointer = { ok: true, x: 300, y: 100 };
    ran.length = 0;
    const r = await run(agent, { op: 'key', combo: 'cmd+s' });
    expect(r).toMatchObject({ ok: false, interrupted: true });
    expect(r.message).toMatch(/user moved the mouse/);
    expect(ran).toEqual([]);
    expect(cursorClaimService.holderAgentId()).toBeNull();
    // forgotten: a fresh claim is never blocked
    await run(agent, { op: 'claim' });
    expect(await run(agent, { op: 'move', x: 5, y: 5 })).toMatchObject({ ok: true });
  });

  it('sends no input when the claim is revoked while the op is in flight', async () => {
    await setup();
    ran.length = 0;
    // /stop lands during the takeover pointer read, after the claim test.
    const inner = deps.runJxa;
    deps.runJxa = jest.fn(async (script: string, args: string[]) => {
      if (script === POINTER_JXA) cursorClaimService.revoke();
      return inner(script, args);
    }) as never;
    const r = await run(agent, { op: 'click', x: 200, y: 200 });
    deps.runJxa = inner;
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/claim ended/);
    expect(ran).not.toContain('click');
  });

  it('does not block when the pointer cannot be read', async () => {
    await setup();
    pointer = { ok: false, error: 'osascript_failed' };
    expect(await run(agent, { op: 'move', x: 200, y: 200 })).toMatchObject({ ok: true });
  });

  it('ignores a stale last-set position', async () => {
    await setup();
    pointer = { ok: true, x: 700, y: 700 };
    now += 21_000;
    cursorClaimService.renew(agent);
    expect(await run(agent, { op: 'move', x: 200, y: 200 })).toMatchObject({ ok: true });
  });

  it('is unaffected in simulated mode', async () => {
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run(agent, { op: 'claim' });
    await run(agent, { op: 'move', x: 100, y: 100 });
    pointer = { ok: true, x: 900, y: 900 };
    expect(await run(agent, { op: 'move', x: 5, y: 5 })).toMatchObject({
      ok: true,
      simulated: true,
    });
  });
});

describe('computer tool error emotion', () => {
  const orig = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: orig }));
  beforeEach(() => cursorClaimService.revoke());
  const cursorEvents = () => {
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    return wsService.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m: { type: string }) => m.type === 'agent:cursor')
      .map((m: { payload: Record<string, unknown> }) => m.payload);
  };
  const clear = () =>
    (
      jest.requireMock('@server/services/WebSocketService') as {
        wsService: { broadcast: jest.Mock };
      }
    ).wsService.broadcast.mockClear();

  it('emits a stumped idle event with the error as label when an op fails', async () => {
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run('test-agent-a', { op: 'claim' });
    clear();
    const r = await run('test-agent-a', { op: 'type' });
    expect(r).toMatchObject({ ok: false, error: 'text is required' });
    const evs = cursorEvents();
    expect(evs[evs.length - 1]).toMatchObject({
      agentId: 'test-agent-a',
      state: 'idle',
      emotion: 'stumped',
      label: 'text is required',
    });
  });

  it('trims long errors to about 160 chars', async () => {
    await run('test-agent-a', { op: 'claim' });
    clear();
    await run('test-agent-a', { op: 'click', target: `e${'x'.repeat(400)}` });
    const last = cursorEvents().pop() as { emotion?: string; label?: string };
    expect(last.emotion).toBe('stumped');
    expect((last.label ?? '').length).toBeLessThanOrEqual(160);
  });

  it('does not emit stumped for busy, ok or simulated replies', async () => {
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    await run('test-agent-a', { op: 'claim' });
    clear();
    expect(await run('test-agent-b', { op: 'move', x: 5, y: 5 })).toMatchObject({ busy: true });
    expect(await run('test-agent-a', { op: 'move', x: 5, y: 5 })).toMatchObject({ ok: true });
    expect(cursorEvents().some((e) => e.emotion)).toBe(false);
  });

  it('does not emit stumped for an interrupted reply', async () => {
    const { deps } = jest.requireActual(
      '@server/services/ToolService/tools/system/computer/tool'
    ) as typeof import('@server/services/ToolService/tools/system/computer/tool');
    const origRun = deps.runJxa;
    let x = 100;
    deps.runJxa = jest.fn(async () => ({ ok: true, x, y: 100 })) as never;
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    try {
      await run('test-agent-a', { op: 'claim' });
      await run('test-agent-a', { op: 'look' });
      await run('test-agent-a', { op: 'move', x: 100, y: 100 });
      clear();
      x = 400; // the user moved the mouse
      expect(await run('test-agent-a', { op: 'move', x: 5, y: 5 })).toMatchObject({
        interrupted: true,
      });
      expect(cursorEvents().some((e) => e.emotion)).toBe(false);
    } finally {
      deps.runJxa = origRun;
      delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
    }
  });
});

describe('visual emote emission', () => {
  const orig = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: orig }));

  it('emits at last position without taking cursor or sending native input', async () => {
    const { emitAvatarEmote } =
      await import('@server/services/ToolService/tools/system/computer/tool');
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    cursorClaimService.revoke();
    // Unknown agents have no last position. Place test-agent-a here rather than relying on an
    // earlier test: releasing a claim forgets the position.
    expect(await emitAvatarEmote('not-on-screen', 'spin')).toBe(false);
    await run('test-agent-a', { op: 'point', x: 120, y: 80 });
    wsService.broadcast.mockClear();
    expect(await emitAvatarEmote('test-agent-a', 'celebrate', 'Tests passed')).toBe(true);
    const payload = wsService.broadcast.mock.calls.at(-1)?.[0].payload;
    expect(payload).toMatchObject({
      agentId: 'test-agent-a',
      state: 'idle',
      animation: 'celebrate',
      emotion: 'proud',
      holderAgentId: null,
    });
    expect(typeof payload.animationId).toBe('string');
    expect(cursorClaimService.holderAgentId()).toBeNull();
  });
  it('the angry shake defaults to the angry face, and an explicit expression wins', async () => {
    const { emitAvatarEmote } =
      await import('@server/services/ToolService/tools/system/computer/tool');
    const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
      wsService: { broadcast: jest.Mock };
    };
    await run('test-agent-a', { op: 'point', x: 120, y: 80 });
    await emitAvatarEmote('test-agent-a', 'angry');
    expect(wsService.broadcast.mock.calls.at(-1)?.[0].payload).toMatchObject({
      animation: 'angry',
      emotion: 'angry',
    });
    await emitAvatarEmote('test-agent-a', undefined, undefined, 'embarrassed');
    expect(wsService.broadcast.mock.calls.at(-1)?.[0].payload).toMatchObject({
      emotion: 'embarrassed',
    });
  });
});

describe('computer tool flower handoff', () => {
  const orig = process.platform;
  const { deps, applyFlowerChoice } = jest.requireActual(
    '@server/services/ToolService/tools/system/computer/tool'
  ) as typeof import('@server/services/ToolService/tools/system/computer/tool');
  const { POINTER_JXA } = jest.requireActual(
    '@server/services/ToolService/tools/system/computer/pointerScript'
  ) as typeof import('@server/services/ToolService/tools/system/computer/pointerScript');
  const { agentCursorSessions } = jest.requireActual(
    '@server/services/agentCursorSessions'
  ) as typeof import('@server/services/agentCursorSessions');
  const { FLOWER_HANDOFF_MS, FLOWER_SETTLE_MS } = jest.requireActual(
    '@snaglet/shared/constants/agentCursor'
  ) as typeof import('@snaglet/shared/constants/agentCursor');
  const { wsService } = jest.requireMock('@server/services/WebSocketService') as {
    wsService: { broadcast: jest.Mock };
  };
  const { markSystemOverlayAlive, resetSystemOverlay } = jest.requireActual(
    '@server/services/systemCursorOverlay'
  ) as typeof import('@server/services/systemCursorOverlay');
  const origRun = deps.runJxa;
  const origSleep = deps.sleep;
  const agent = 'test-agent-a';
  let now: number;
  let nowSpy: jest.SpyInstance;
  let pointer: Record<string, unknown>;
  /** Everything that reaches the screen or the overlays, in order. */
  let seq: string[];
  /** Each agent's current cursor session, from the events it emits. */
  let sessionOf: Record<string, string>;
  let onSleep: (ms: number) => void;
  /** Runs when the op asks which app is in front (the allowlist check, just before input). */
  let onFront: () => void;

  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: orig });
    deps.runJxa = origRun;
    deps.sleep = origSleep;
  });
  beforeEach(() => {
    cursorClaimService.revoke();
    agentCursorSessions.reset();
    delete process.env.SNAGLET_COMPUTER_ALLOWED_APPS;
    process.env.SNAGLET_COMPUTER_ALLOW_INPUT = '1';
    now = 5_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    pointer = { ok: true, x: 100, y: 100 };
    seq = [];
    onSleep = () => undefined;
    onFront = () => undefined;
    sessionOf = {};
    wsService.broadcast.mockImplementation(
      (m: { type: string; payload: { state?: string; agentId?: string; session?: string } }) => {
        if (m.type === 'agent:cursor' && m.payload.agentId && m.payload.session)
          sessionOf[m.payload.agentId] = m.payload.session;
        seq.push(m.type === 'agent:cursor' ? `emit:${m.payload.state}` : m.type);
      }
    );
    deps.sleep = jest.fn(async (ms: number) => {
      seq.push(`sleep:${ms}`);
      now += ms;
      onSleep(ms);
    });
    deps.runJxa = jest.fn(async (script: string, args: string[]) => {
      if (script === POINTER_JXA) return pointer;
      if (!['look', 'focus', 'front'].includes(args[0])) seq.push(`input:${args[0]}`);
      if (args[0] === 'look') return { ok: true, app: 'Notes', title: '', elements: [] };
      if (args[0] === 'focus') return { ok: true, role: 'AXTextField', subrole: '', label: 'n' };
      if (args[0] === 'front') {
        onFront();
        return { ok: true, app: 'Notes', title: '' };
      }
      return { ok: true };
    }) as never;
  });
  afterEach(() => {
    nowSpy.mockRestore();
    delete process.env.SNAGLET_COMPUTER_ALLOWED_APPS;
    wsService.broadcast.mockReset();
    resetSystemOverlay();
    delete process.env.SNAGLET_COMPUTER_ALLOW_INPUT;
  });

  const from = (pointer?: { x: number; y: number }) => ({
    session: sessionOf[agent],
    ...(pointer ? { pointer } : {}),
  });

  const ready = async () => {
    await run(agent, { op: 'claim' });
    await run(agent, { op: 'look' });
    expect(await run(agent, { op: 'move', x: 100, y: 100 })).toMatchObject({ ok: true });
    seq = [];
  };

  it('after a quiet spell, emits the event, waits the handoff, then clicks', async () => {
    await ready();
    now += FLOWER_SETTLE_MS;
    expect(await run(agent, { op: 'click', x: 100, y: 100 })).toMatchObject({ ok: true });
    expect(seq).toEqual(['emit:click', `sleep:${FLOWER_HANDOFF_MS}`, 'input:click']);
  });

  it('waits the same way before a drag or a scroll at the pointer', async () => {
    await ready();
    now += FLOWER_SETTLE_MS;
    await run(agent, { op: 'scroll', dy: 3 });
    expect(seq).toEqual(['emit:move', `sleep:${FLOWER_HANDOFF_MS}`, 'input:scroll']);
    seq = [];
    now += FLOWER_SETTLE_MS;
    await run(agent, { op: 'drag', from: { x: 100, y: 100 }, to: { x: 200, y: 200 } });
    expect(seq).toEqual(['emit:drag', `sleep:${FLOWER_HANDOFF_MS}`, 'input:drag']);
  });

  it('does not wait while the flower is still settling from the last action', async () => {
    await ready();
    now += FLOWER_SETTLE_MS - FLOWER_HANDOFF_MS - 1;
    await run(agent, { op: 'click', x: 100, y: 100 });
    expect(seq).toEqual(['emit:click', 'input:click']);
  });

  it('never waits before keystrokes, which the flower cannot catch', async () => {
    await ready();
    now += FLOWER_SETTLE_MS;
    await run(agent, { op: 'key', combo: 'cmd+s' });
    expect(seq).toEqual(['emit:click', 'input:key']);
  });

  it('does not wait once the flower has been hidden for a settle time', async () => {
    await ready();
    expect(applyFlowerChoice(agent, { dismiss: true }, from())).toBe(true);
    now += FLOWER_SETTLE_MS;
    seq = [];
    await run(agent, { op: 'click', x: 100, y: 100 });
    expect(seq).toEqual(['emit:click', 'input:click']);
  });

  it('sends nothing when the cursor is stopped during the handoff', async () => {
    await ready();
    now += FLOWER_SETTLE_MS;
    onSleep = (ms) => {
      if (ms === FLOWER_HANDOFF_MS) cursorClaimService.revoke();
    };
    const r = await run(agent, { op: 'click', x: 100, y: 100 });
    expect(r.error).toMatch(/claim ended/);
    expect(seq).not.toContain('input:click');
  });

  it('waits while the person drags the flower, and their mouse move is not a takeover', async () => {
    await ready();
    expect(agentCursorSessions.grab(agent, sessionOf[agent], true)).toBe(true);
    // The person is dragging: the pointer is far from where the agent left it.
    pointer = { ok: true, x: 400, y: 300 };
    let polls = 0;
    onSleep = () => {
      if (++polls === 3)
        applyFlowerChoice(agent, { park: { x: 430, y: 340 } }, from({ x: 400, y: 300 }));
    };
    const r = await run(agent, { op: 'click', x: 100, y: 100 });
    expect(r).toMatchObject({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(seq.indexOf('agent:cursor-flower')).toBeLessThan(seq.indexOf('emit:click'));
    expect(seq.at(-1)).toBe('input:click');
  });

  it('hiding the flower is not a takeover either', async () => {
    await ready();
    pointer = { ok: true, x: 70, y: 60 };
    applyFlowerChoice(agent, { dismiss: true }, from({ x: 70, y: 60 }));
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ ok: true });
    expect(cursorClaimService.holderAgentId()).toBe(agent);
  });

  it('after the ×, using the mouse elsewhere is still taking the pointer back', async () => {
    await ready();
    applyFlowerChoice(agent, { dismiss: true }, from({ x: 70, y: 60 }));
    pointer = { ok: true, x: 600, y: 500 };
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ interrupted: true });
  });

  it("waits while the person holds another agent's flower", async () => {
    const other = 'test-agent-b';
    await run(other, { op: 'claim' });
    await run(other, { op: 'point', x: 700, y: 500 });
    await run(other, { op: 'release' });
    await ready();
    expect(agentCursorSessions.grab(other, sessionOf[other], true)).toBe(true);
    let polls = 0;
    onSleep = () => {
      if (++polls === 4) agentCursorSessions.grab(other, sessionOf[other], false);
    };
    expect(await run(agent, { op: 'click', x: 100, y: 100 })).toMatchObject({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(4);
  });

  it('with the system overlay reporting its display, waits only for clicks near a flower', async () => {
    markSystemOverlayAlive(Date.now(), { width: 1440, height: 900 });
    const other = 'test-agent-b';
    await run(other, { op: 'claim' });
    await run(other, { op: 'look' });
    await run(other, { op: 'move', x: 500, y: 300 });
    await run(other, { op: 'release' });
    await ready();
    now += FLOWER_SETTLE_MS;
    markSystemOverlayAlive(Date.now(), { width: 1440, height: 900 });
    seq = [];
    await run(agent, { op: 'click', x: 1000, y: 700 });
    expect(seq).toEqual(['emit:click', 'input:click']);
    pointer = { ok: true, x: 1000, y: 700 };
    now += FLOWER_SETTLE_MS;
    seq = [];
    // On the other agent's idle flower (up-left of 500, 300).
    await run(agent, { op: 'click', x: 470, y: 270 });
    expect(seq).toEqual(['emit:click', `sleep:${FLOWER_HANDOFF_MS}`, 'input:click']);
  });

  it('waits before a click that follows another action at once, while a still flower may lag', async () => {
    await ready();
    now += FLOWER_SETTLE_MS;
    // Two ops in the same turn: the first one's event comes milliseconds before the click.
    await run(agent, { op: 'point', x: 300, y: 300 });
    expect(seq.at(-1)).toBe('emit:idle');
    seq = [];
    await run(agent, { op: 'click', x: 100, y: 100 });
    expect(seq).toEqual(['emit:click', `sleep:${FLOWER_HANDOFF_MS}`, 'input:click']);
  });

  it("waits before a click while another agent's flower may be taking the mouse", async () => {
    // Another agent works and lets go: its flower stays up, idle, and settles.
    const other = 'test-agent-b';
    await run(other, { op: 'claim' });
    await run(other, { op: 'look' });
    await run(other, { op: 'move', x: 500, y: 300 });
    await run(other, { op: 'release' });
    now += FLOWER_SETTLE_MS;
    await ready();
    // This agent's own flower is gone, so only the other one can be under the click.
    await run(agent, { op: 'hide' });
    now += FLOWER_SETTLE_MS;
    seq = [];
    await run(agent, { op: 'click', x: 480, y: 270 });
    expect(seq).toEqual(['emit:click', `sleep:${FLOWER_HANDOFF_MS}`, 'input:click']);
  });

  it('reaching for the flower is not a takeover: the op waits while the pointer is on it', async () => {
    await ready();
    // The flower sits up-left of the agent's point (100, 100); the person reaches for it.
    pointer = { ok: true, x: 70, y: 60 };
    let polls = 0;
    onSleep = () => {
      // They change their mind and leave the pointer where the agent had it.
      if (++polls === 3) pointer = { ok: true, x: 100, y: 100 };
    };
    expect(await run(agent, { op: 'click', x: 200, y: 200 })).toMatchObject({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(cursorClaimService.holderAgentId()).toBe(agent);
  });

  it('a pointer that stays on the flower too long, or goes elsewhere, is still a takeover', async () => {
    await ready();
    pointer = { ok: true, x: 70, y: 60 };
    const r = await run(agent, { op: 'click', x: 200, y: 200 });
    expect(r).toMatchObject({ ok: false, interrupted: true });
    expect(seq).not.toContain('input:click');
    await ready();
    pointer = { ok: true, x: 400, y: 400 };
    seq = [];
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ interrupted: true });
    expect(seq.filter((e) => e.startsWith('sleep'))).toEqual([]);
  });

  it('a × from the keyboard keeps the takeover check: the mouse never went to the flower', async () => {
    await ready();
    applyFlowerChoice(agent, { dismiss: true }, from());
    pointer = { ok: true, x: 400, y: 400 };
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ interrupted: true });
  });

  it("hiding another agent's flower is not a takeover of the agent at work", async () => {
    const other = 'test-agent-b';
    await run(other, { op: 'claim' });
    await run(other, { op: 'point', x: 500, y: 300 });
    await run(other, { op: 'release' });
    await ready();
    // The person reaches over to the other agent's leftover flower and clicks its ×.
    pointer = { ok: true, x: 470, y: 270 };
    expect(
      applyFlowerChoice(
        other,
        { dismiss: true },
        { session: sessionOf[other], pointer: { x: 470, y: 270 } }
      )
    ).toBe(true);
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ ok: true });
    expect(cursorClaimService.holderAgentId()).toBe(agent);
  });

  it('a pointer nowhere near the flower does not move the takeover check', async () => {
    await ready();
    applyFlowerChoice(agent, { dismiss: true }, from({ x: 900, y: 800 }));
    pointer = { ok: true, x: 900, y: 800 };
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ interrupted: true });
  });

  it('a flower the person pressed and dragged away counts from where they let go', async () => {
    await ready();
    agentCursorSessions.grab(agent, sessionOf[agent], true);
    // Dragged off the left edge of the display, which hides it.
    applyFlowerChoice(agent, { dismiss: true }, from({ x: 2, y: 400 }));
    pointer = { ok: true, x: 2, y: 400 };
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ ok: true });
  });

  it('a hold that starts just before the input still holds it, and the flowers are re-checked', async () => {
    process.env.SNAGLET_COMPUTER_ALLOWED_APPS = 'notes';
    await ready();
    seq = [];
    onFront = () => {
      agentCursorSessions.grab(agent, sessionOf[agent], true);
    };
    let polls = 0;
    onSleep = (ms) => {
      if (ms === 100 && ++polls === 2)
        applyFlowerChoice(agent, { park: { x: 130, y: 140 } }, from({ x: 100, y: 100 }));
    };
    expect(await run(agent, { op: 'click', x: 100, y: 100 })).toMatchObject({ ok: true });
    const parked = seq.indexOf('agent:cursor-flower');
    expect(parked).toBeGreaterThan(-1);
    expect(seq.indexOf('sleep:100')).toBeLessThan(parked);
    // After the drop the click is announced again, and always waited for: the panel the person
    // was dragging may still sit at its old spot (unknown here) for one native poll.
    expect(seq.slice(parked + 1)).toEqual([
      'emit:click',
      `sleep:${FLOWER_HANDOFF_MS}`,
      'input:click',
    ]);
  });

  it('after a hold, keystrokes still do not wait for the hand-off', async () => {
    process.env.SNAGLET_COMPUTER_ALLOWED_APPS = 'notes';
    await ready();
    seq = [];
    onFront = () => {
      agentCursorSessions.grab(agent, sessionOf[agent], true);
    };
    onSleep = (ms) => {
      if (ms === 100) agentCursorSessions.grab(agent, sessionOf[agent], false);
    };
    expect(await run(agent, { op: 'key', combo: 'cmd+s' })).toMatchObject({ ok: true });
    expect(seq).not.toContain(`sleep:${FLOWER_HANDOFF_MS}`);
  });

  it('cursor events carry the session and the choice; the choice is broadcast at once', async () => {
    const payloads: Array<{ type: string; payload: Record<string, unknown> }> = [];
    wsService.broadcast.mockImplementation((m: (typeof payloads)[number]) => payloads.push(m));
    await ready();
    const session = payloads.at(-1)?.payload.session;
    expect(typeof session).toBe('string');
    applyFlowerChoice(agent, { park: { x: 12, y: 34 } }, { session: String(session) });
    expect(payloads.at(-1)).toEqual({
      type: 'agent:cursor-flower',
      payload: { agentId: agent, session, dismissed: false, parkedAt: { x: 12, y: 34 } },
    });
    await run(agent, { op: 'move', x: 150, y: 150 });
    expect(payloads.at(-1)?.payload).toMatchObject({ session, parkedAt: { x: 12, y: 34 } });
    expect(applyFlowerChoice('test-agent-never-seen', { dismiss: true }, { session: 'x' })).toBe(
      false
    );
    // A late action for an earlier session never lands on this one.
    expect(applyFlowerChoice(agent, { dismiss: true }, { session: 'cursor-old' })).toBe(false);
  });
});
