import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat, readFile } from 'node:fs/promises';
import { defaultCursorSpec } from '@snaglet/shared/cursor';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import { BrowserController } from '@server/services/BrowserController/BrowserController';
import type { ApprovalPort } from '@server/services/BrowserController/BrowserController';
import {
  ProfileError,
  assertProfileId,
  createProfile,
  deleteProfile,
  listProfiles,
  profileDir,
} from '@server/services/BrowserController/profiles';
import { checkSite, isSecureField } from '@server/services/BrowserController/policy';
import type {
  BrowserDriver,
  DriverContext,
  DriverPage,
  ElementInfo,
  LaunchOptions,
} from '@server/services/BrowserController/types';

class FakePage implements DriverPage {
  calls: string[] = [];
  current = 'about:blank';
  elements: ElementInfo[] = [];
  focused: ElementInfo | null = null;
  redirectTo: string | null = null;
  closed = false;
  navCb: Array<(u: string) => void> = [];
  installed: string[] = [];
  truncated = false;
  url = () => this.current;
  title = async () => 'T';
  async goto(u: string) {
    this.calls.push(`goto ${u}`);
    this.current = u === 'about:blank' ? u : (this.redirectTo ?? u);
    this.navCb.forEach((c) => c(this.current));
  }
  async nav(k: 'back' | 'forward' | 'reload') {
    this.calls.push(`nav ${k}`);
    this.navCb.forEach((c) => c(this.current));
  }
  async close() {
    this.closed = true;
  }
  isClosed = () => this.closed;
  bringToFront = async () => undefined;
  frameList: Array<{ index: number; name: string; url: string }> = [
    { index: 0, name: '', url: 'x' },
  ];
  frameSeen: Array<string | undefined> = [];
  readText = { markdown: '# Title\n\nHello', truncated: false };
  flowers: Array<{ t: unknown; state: string; label?: string }> = [];
  consoleCb: Array<(e: { level: 'error' | 'warn' | 'log'; text: string }) => void> = [];
  netCb: Array<(e: { method: string; url: string; status: number }) => void> = [];
  checked = false;
  async collect(max: number, frame?: string) {
    this.frameSeen.push(frame);
    return {
      elements: this.elements.slice(0, max),
      truncated: this.truncated || this.elements.length > max,
    };
  }
  frames = () => this.frameList;
  read = async (o: { ref?: string; frame?: string; max: number }) => {
    this.calls.push(`read ${o.ref ?? ''} ${o.frame ?? ''} ${o.max}`);
    return this.readText;
  };
  describeAt = async () => this.elements[0] ?? null;
  describeFocused = async () => this.focused;
  async click(t: object, o: object) {
    this.calls.push(`click ${JSON.stringify(t)} ${JSON.stringify(o)}`);
  }
  async hover(t: object, m: string[]) {
    this.calls.push(`hover ${JSON.stringify(t)} ${m.join('+')}`);
  }
  async drag() {
    this.calls.push('drag');
    return { strategy: 'mouse-steps' };
  }
  async dragPath(_s: unknown, p: unknown[]) {
    this.calls.push(`dragPath ${p.length}`);
  }
  async mouse(a: { action: string }) {
    this.calls.push(`mouse ${a.action}`);
  }
  async type(t: { ref: string; frame?: string }, text: string, submit: boolean) {
    this.calls.push(`type ${t.ref} ${text} ${submit}`);
  }
  async fill(t: { ref: string; frame?: string }, text: string) {
    this.calls.push(`fill ${t.ref} ${text} ${t.frame ?? ''}`);
  }
  async clear(t: { ref: string }) {
    this.calls.push(`clear ${t.ref}`);
  }
  async setChecked(_t: unknown, want: boolean) {
    if (this.checked === want) return 'already' as const;
    this.checked = want;
    return 'changed' as const;
  }
  beforeKey: (() => void) | null = null;
  async press(k: string) {
    this.beforeKey?.();
    this.calls.push(`press ${k}`);
  }
  holdEnd: 'done' | 'aborted' | 'closed' | 'dialog' = 'done';
  holdSignals: Array<AbortSignal | undefined> = [];
  async holdKeys(keys: string[], ms: number, signal?: AbortSignal) {
    this.beforeKey?.();
    this.calls.push(`hold ${keys.join(',')} ${ms}`);
    this.holdSignals.push(signal);
    return { end: this.holdEnd, heldMs: this.holdEnd === 'done' ? ms : 0 };
  }
  async select() {
    this.calls.push('select');
  }
  async upload(_t: unknown, f: string[]) {
    this.calls.push(`upload ${f.join(',')}`);
  }
  async scroll() {
    this.calls.push('scroll');
  }
  async wait() {
    this.calls.push('wait');
  }
  async pdf(p: string) {
    this.calls.push(`pdf ${p}`);
    await writeFile(p, 'pdf');
  }
  async resize(w: number, h: number) {
    this.calls.push(`resize ${w}x${h}`);
  }
  themes: unknown[] = [];
  avatars: unknown[] = [];
  emotions: Array<{ emotion: string; ttlMs: number }> = [];
  async setEmotion(emotion: string, ttlMs: number) {
    this.emotions.push({ emotion, ttlMs });
  }
  async flower(
    t: unknown,
    state: 'move' | 'click' | 'drag' | 'error',
    label?: string,
    theme?: unknown,
    avatar?: unknown
  ) {
    this.themes.push(theme);
    this.avatars.push(avatar);
    this.flowers.push({ t, state, label });
  }
  onConsole(cb: (e: { level: 'error' | 'warn' | 'log'; text: string }) => void) {
    this.consoleCb.push(cb);
  }
  onNetwork(cb: (e: { method: string; url: string; status: number }) => void) {
    this.netCb.push(cb);
  }
  screenshot = async () => Buffer.from('png');
  dialogOpen: { type: string; message: string } | null = null;
  pendingDialog = () => this.dialogOpen;
  async handleDialog() {
    return undefined;
  }
  async installCursor(s: string) {
    this.installed.push(s);
  }
  onDownload() {
    return undefined;
  }
  onNavigated(cb: (u: string) => void) {
    this.navCb.push(cb);
  }
  onClosed() {
    return undefined;
  }
}

class FakeCtx implements DriverContext {
  pages: FakePage[] = [];
  closedCb: Array<() => void> = [];
  closed = false;
  note?: string;
  async newPage() {
    const p = new FakePage();
    this.pages.push(p);
    return p;
  }
  async ensureWindow() {
    return undefined;
  }
  traces: string[] = [];
  async traceStart() {
    this.traces.push('start');
  }
  async traceStop(p: string) {
    this.traces.push(`stop ${p}`);
    await writeFile(p, 'zip');
  }
  async close() {
    this.closed = true;
    this.closedCb.forEach((c) => c());
  }
  onClosed(cb: () => void) {
    this.closedCb.push(cb);
  }
}

const el = (o: Partial<ElementInfo> & { ref: string }): ElementInfo => ({
  role: 'button',
  name: 'Item',
  ...o,
});

describe('BrowserController', () => {
  let home: string;
  let projDir: string;
  let t: number;
  let env: NodeJS.ProcessEnv;
  let launches: LaunchOptions[];
  let ctxs: FakeCtx[];
  let outcome: 'allow' | 'allow-session' | 'deny' | 'timeout';
  let requests: number;
  let grants: Set<string>;
  let handoffs: Array<{ message: string; timeoutMs: number }>;
  let handoffOutcome: 'allow' | 'deny' | 'timeout';
  let timers: Array<() => void>;
  let sleeps: number[];
  let c: BrowserController;

  const A = {
    id: 'test-agent-a',
    name: 'Test A',
    flower: 'daisy',
    color: '#fff',
    cursorSpec: defaultCursorSpec('test-agent-a'),
    cwd: '',
  };
  const B = { id: 'test-agent-b', name: 'Test B', flower: 'rose', color: '#000' };
  const page = (i = 0, ctx = 0) => ctxs[ctx].pages[i];

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'snaglet-browser-test-'));
    projDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-browser-proj-'));
    A.cwd = projDir;
    t = 1_000;
    env = { SNAGLET_BROWSER_REQUIRE_APPROVAL: '1', SNAGLET_BROWSER_CURSOR_DELAY_MS: '0' };
    sleeps = [];
    launches = [];
    ctxs = [];
    outcome = 'allow';
    requests = 0;
    grants = new Set();
    handoffs = [];
    handoffOutcome = 'allow';
    timers = [];
    const driver: BrowserDriver = {
      async launch(o) {
        launches.push(o);
        const ctx = new FakeCtx();
        ctxs.push(ctx);
        return ctx;
      },
    };
    const approval: ApprovalPort = {
      handoff: async (i) => {
        handoffs.push(i);
        return handoffOutcome;
      },
      required: () => env.SNAGLET_BROWSER_REQUIRE_APPROVAL !== '0',
      hasGrant: (a, p) => grants.has(`${a}/${p}`),
      request: async (i) => {
        requests += 1;
        if (outcome === 'allow-session') grants.add(`${i.agentId}/${i.profile}`);
        return outcome;
      },
    };
    c = new BrowserController({
      driver,
      home: () => home,
      now: () => t,
      approval,
      log: () => undefined,
      env: () => env,
      startSweeper: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      palette: async () => ({ ...defaultWorkspaceColors }),
      theme: async () =>
        ({ background: '#111111', text: '#eeeeee', border: '#333333', extra: 1 }) as never,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  });

  const open = (agent = A, extra = {}) =>
    c.run(agent, { op: 'open', url: 'https://example.com/', ...extra });
  const snap = async (
    agent = A,
    els: ElementInfo[] = [el({ ref: 'e1', name: 'Save draft' })],
    pi = 0
  ) => {
    page(pi).elements = els;
    return c.run(agent, { op: 'snapshot' });
  };

  describe('approval', () => {
    it('asks on first use, allow lets the open through, deny blocks', async () => {
      outcome = 'deny';
      const r = await open();
      expect(r).toMatchObject({ ok: false, denied: true });
      expect(ctxs).toHaveLength(0);
      outcome = 'allow';
      expect(await open()).toMatchObject({ ok: true, tab: 't1', profile: 'main' });
      expect(requests).toBe(2);
    });
    it('does not re-ask while the agent has an open tab; timeout reported', async () => {
      await open();
      await open();
      expect(requests).toBe(1);
      outcome = 'timeout';
      expect(await open(B)).toMatchObject({ ok: false, timedOut: true });
    });
    it('allow-session is remembered per (agent, profile)', async () => {
      outcome = 'allow-session';
      await open();
      await c.run(A, { op: 'close' });
      await open();
      expect(requests).toBe(1);
      await open(A, { profile: 'work' });
      expect(requests).toBe(2);
    });
    it('temp needs none, and SNAGLET_BROWSER_REQUIRE_APPROVAL=0 disables', async () => {
      await open(A, { profile: 'temp' });
      expect(requests).toBe(0);
      expect(launches[0].profileDir).toBeNull();
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open(B);
      expect(requests).toBe(0);
      expect(launches[1].profileDir).toBe(path.join(home, 'browser-profiles', 'main'));
    });
    it('rejects bad profile ids', async () => {
      expect(await open(A, { profile: '../etc' })).toMatchObject({ ok: false });
      expect(launches).toHaveLength(0);
    });
  });

  describe('tabs and refs', () => {
    beforeEach(() => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
    });
    it('agent B cannot act on agent A tabs', async () => {
      await open(A);
      await open(B);
      expect(ctxs).toHaveLength(1); // one context shared
      const r = await c.run(B, { op: 'snapshot', tab: 't1' });
      // B has its own t1 (per-agent ids): it must resolve to B's page, never A's
      expect(r).toMatchObject({ ok: true });
      expect(page(1).calls).toEqual(['goto https://example.com/']);
      const bad = await c.run(B, { op: 'close', tab: 't2' });
      expect(bad).toMatchObject({ ok: false });
      expect(page(0).closed).toBe(false);
      const tabs = (await c.run(B, { op: 'tabs' })).tabs as unknown[];
      expect(tabs).toHaveLength(1);
    });
    it('needs an open tab first', async () => {
      expect(await c.run(A, { op: 'snapshot' })).toMatchObject({ ok: false });
    });
    it('resolves refs and goes stale after navigation or a new snapshot', async () => {
      await open();
      const s = await snap();
      expect(s.outline).toEqual(['e1 button "Save draft"']);
      expect(await c.run(A, { op: 'click', ref: 'e9' })).toMatchObject({ ok: false });
      expect(await c.run(A, { op: 'hover', ref: 'e1' })).toMatchObject({ ok: true });
      await c.run(A, { op: 'navigate', to: 'reload' });
      const r = await c.run(A, { op: 'hover', ref: 'e1' });
      expect(r).toMatchObject({ ok: false });
      expect(String(r.error)).toMatch(/stale/);
    });
    it('caps the snapshot at 200 and says truncated', async () => {
      await open();
      const many = Array.from({ length: 260 }, (_, i) => el({ ref: `e${i + 1}`, name: `n${i}` }));
      const s = await snap(A, many);
      expect(s.count).toBe(200);
      expect(s.truncated).toBe(true);
    });
    it('installs the agent cursor identity on its page', async () => {
      await open();
      expect(page().installed[0]).toContain('window.__snagletAgentCursor');
      expect(page().installed[0]).toContain('"daisy"');
      expect(page().installed[0]).toContain(
        '"theme":{"background":"#111111","text":"#eeeeee","border":"#333333"}'
      );
    });
    it('installs the avatar data URL and petal ring color in the identity', async () => {
      await open();
      const inst = page().installed[0];
      expect(inst).toContain('"avatar":"data:image/svg+xml;base64,');
      expect(inst).toContain('"avatarStumped":"data:image/svg+xml;base64,');
      const petal = defaultWorkspaceColors[A.cursorSpec.colors.petal];
      expect(inst).toContain(`"ringColor":"${petal}"`);
    });
    it('passes the avatar and ring color on each flower op', async () => {
      await open();
      await c.run(A, { op: 'click', x: 5, y: 6 });
      const av = page().avatars.at(-1) as { avatar: string; ringColor: string };
      expect(av.avatar.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(av.ringColor).toBe(defaultWorkspaceColors[A.cursorSpec.colors.petal]);
    });
    it('passes the current theme to the page on each flower op', async () => {
      await open();
      page().flowers.length = 0;
      await c.run(A, { op: 'click', x: 5, y: 6 });
      expect(page().themes.at(-1)).toEqual({
        background: '#111111',
        text: '#eeeeee',
        border: '#333333',
      });
    });
    it('drag clears refs and reports the strategy', async () => {
      await open();
      await snap(A, [el({ ref: 'e1', name: 'one' }), el({ ref: 'e2', name: 'two' })]);
      expect(await c.run(A, { op: 'drag', from: 'e1', to: 'e2' })).toMatchObject({
        ok: true,
        strategy: 'mouse-steps',
      });
      expect(await c.run(A, { op: 'hover', ref: 'e1' })).toMatchObject({ ok: false });
    });
  });

  describe('secure fields', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it.each([
      [{ type: 'password' }],
      [{ type: 'text', autocomplete: 'cc-number' }],
      [{ type: 'text', autocomplete: 'new-password' }],
      [{ type: 'text', name: 'Your API key' }],
    ])('refuses to type into %j', async (extra) => {
      await snap(A, [el({ ref: 'e1', role: 'textbox', name: 'Field', ...extra })]);
      const r = await c.run(A, { op: 'type', ref: 'e1', text: 'hunter2' });
      expect(r).toMatchObject({ ok: false });
      expect(page().calls.some((x) => x.startsWith('type'))).toBe(false);
    });
    it('types into normal fields, and refuses key presses in secure ones', async () => {
      await snap(A, [el({ ref: 'e1', role: 'textbox', name: 'Search' })]);
      expect(await c.run(A, { op: 'type', ref: 'e1', text: 'hi' })).toMatchObject({ ok: true });
      page().focused = el({ ref: '', role: 'textbox', name: 'Password', type: 'password' });
      expect(await c.run(A, { op: 'press', key: 'a' })).toMatchObject({ ok: false });
      expect(await c.run(A, { op: 'press', key: 'Tab' })).toMatchObject({ ok: true });
    });
    it('isSecureField unit', () => {
      expect(isSecureField({ name: 'CVV code' })).toBe(true);
      expect(isSecureField({ name: 'Email', type: 'email' })).toBe(false);
    });
  });

  describe('danger gate', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it('click needs approved:true on a Send button', async () => {
      await snap(A, [el({ ref: 'e1', name: 'Send message' })]);
      const r = await c.run(A, { op: 'click', ref: 'e1' });
      expect(r).toMatchObject({ ok: false, needsApproval: true });
      expect(page().calls.some((x) => x.startsWith('click'))).toBe(false);
      expect(await c.run(A, { op: 'click', ref: 'e1', approved: true })).toMatchObject({
        ok: true,
      });
      expect(page().calls.some((x) => x.startsWith('click'))).toBe(true);
    });
    it('gates coordinate clicks, Enter on a dangerous focus, and select', async () => {
      page().elements = [el({ ref: '', name: 'Delete account' })];
      expect(await c.run(A, { op: 'click', x: 5, y: 5 })).toMatchObject({ needsApproval: true });
      page().focused = el({ ref: '', name: 'Buy now' });
      expect(await c.run(A, { op: 'press', key: 'Enter' })).toMatchObject({ needsApproval: true });
      await snap(A, [el({ ref: 'e1', role: 'combobox', name: 'Action' })]);
      expect(await c.run(A, { op: 'select', ref: 'e1', option: 'Delete all' })).toMatchObject({
        needsApproval: true,
      });
      expect(await c.run(A, { op: 'select', ref: 'e1', option: 'Archive' })).toMatchObject({
        ok: true,
      });
    });
    it('gates type submit, dialog accept and drag onto dangerous targets', async () => {
      await snap(A, [
        el({ ref: 'e1', role: 'textbox', name: 'Post a comment' }),
        el({ ref: 'e2', role: 'textbox', name: 'Search' }),
        el({ ref: 'e3', name: 'Delete' }),
        el({ ref: 'e4', name: 'Card' }),
      ]);
      const typed = (ref: string, extra = {}) =>
        c.run(A, { op: 'type', ref, text: 'hi', submit: true, ...extra });
      expect(await typed('e1')).toMatchObject({ ok: false, needsApproval: true });
      expect(page().calls.some((x) => x.startsWith('type e1'))).toBe(false);
      expect(await typed('e1', { approved: true })).toMatchObject({ ok: true });
      expect(await typed('e2')).toMatchObject({ ok: true });
      expect(await c.run(A, { op: 'type', ref: 'e1', text: 'hi' })).toMatchObject({ ok: true });

      expect(await c.run(A, { op: 'drag', from: 'e4', to: 'e3' })).toMatchObject({
        needsApproval: true,
      });
      expect(await c.run(A, { op: 'drag', from: 'e3', to: 'e4' })).toMatchObject({
        needsApproval: true,
      });
      expect(page().calls).not.toContain('drag');
      expect(
        await c.run(A, { op: 'drag', from: 'e3', path: [{ x: 1, y: 1 }], approved: true })
      ).toMatchObject({ ok: true });

      page().pendingDialog = () => ({ type: 'confirm', message: 'Delete everything?' });
      expect(await c.run(A, { op: 'dialog', action: 'accept' })).toMatchObject({
        needsApproval: true,
      });
      expect(await c.run(A, { op: 'dialog', action: 'accept', approved: true })).toMatchObject({
        ok: true,
      });
    });
  });

  describe('site policy', () => {
    beforeEach(() => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
    });
    it('blocks listed hosts and subdomains on open and navigate', async () => {
      env.SNAGLET_BROWSER_BLOCKED_SITES = 'evil.com';
      expect(await open(A, { url: 'https://a.evil.com/x' })).toMatchObject({ ok: false });
      await open();
      expect(await c.run(A, { op: 'navigate', url: 'https://evil.com' })).toMatchObject({
        ok: false,
      });
    });
    it('allowlist rejects others; redirect to a blocked host is caught', async () => {
      env.SNAGLET_BROWSER_ALLOWED_SITES = 'example.com';
      expect(await open(A, { url: 'https://other.org' })).toMatchObject({ ok: false });
      await open();
      page().redirectTo = 'https://other.org/landing';
      const r = await c.run(A, { op: 'navigate', url: 'https://example.com/go' });
      expect(r).toMatchObject({ ok: false });
      expect(String(r.error)).toMatch(/redirect/);
      expect(page().current).toBe('about:blank');
    });
    it('checkSite basics', () => {
      expect(checkSite('file:///etc/passwd', {})).toMatch(/not allowed/);
      expect(checkSite('data:text/html,hi', {})).toBeNull();
      expect(checkSite('https://x.com', { SNAGLET_BROWSER_ALLOWED_SITES: 'y.com' })).toMatch(
        /allowed/
      );
    });
  });

  describe('upload', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
      await snap(A, [el({ ref: 'e1', role: 'file', name: 'File' })]);
    });
    it('allows files inside the project folder only', async () => {
      await writeFile(path.join(A.cwd, 'a.txt'), 'x');
      await writeFile(path.join(home, 'secret.txt'), 'x');
      expect(await c.run(A, { op: 'upload', ref: 'e1', files: ['a.txt'] })).toMatchObject({
        ok: true,
      });
      expect(await c.run(A, { op: 'upload', ref: 'e1', files: ['../secret.txt'] })).toMatchObject({
        ok: false,
      });
      await symlink(path.join(home, 'secret.txt'), path.join(A.cwd, 'link.txt'));
      expect(await c.run(A, { op: 'upload', ref: 'e1', files: ['link.txt'] })).toMatchObject({
        ok: false,
      });
      // an agent whose cwd falls back to Snaglet home cannot upload Snaglet private data
      await mkdir(path.join(home, 'browser-profiles'), { recursive: true });
      await writeFile(path.join(home, 'browser-profiles', 'cookies'), 'x');
      const rooted = await c.run(
        { ...A, cwd: home },
        { op: 'upload', ref: 'e1', files: ['browser-profiles/cookies'] }
      );
      expect(rooted).toMatchObject({ ok: false });
    });
  });

  describe('idle shutdown', () => {
    it('closes a profile after SNAGLET_BROWSER_IDLE_MS without calls and not before', async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      env.SNAGLET_BROWSER_IDLE_MS = '600000';
      await open();
      t += 599_000;
      expect(await c.sweepIdle()).toEqual([]);
      await c.run(A, { op: 'tabs' }); // a call resets the clock
      t += 599_000;
      expect(await c.sweepIdle()).toEqual([]);
      t += 2_000;
      expect(await c.sweepIdle()).toEqual(['main']);
      expect(ctxs[0].closed).toBe(true);
      expect(c.isRunning('main')).toBe(false);
      expect(await c.run(A, { op: 'snapshot' })).toMatchObject({ ok: false });
    });
    it('keeps a user sign-in session open', async () => {
      await c.openForUser('main');
      t += 3_600_000;
      expect(await c.sweepIdle()).toEqual([]);
    });
  });

  describe('profiles', () => {
    it('validates ids and blocks traversal', () => {
      expect(() => assertProfileId('Bad_Id')).toThrow(ProfileError);
      expect(() => assertProfileId('..')).toThrow(ProfileError);
      expect(() => assertProfileId('a'.repeat(33))).toThrow(ProfileError);
      expect(() => profileDir(home, '../x')).toThrow(ProfileError);
      expect(profileDir(home, 'work-1')).toBe(path.join(home, 'browser-profiles', 'work-1'));
    });
    it('creates, lists, refuses delete while running, then deletes', async () => {
      const p = await createProfile(home, 'Work Gmail');
      expect(p.id).toBe('work-gmail');
      await expect(createProfile(home, 'Work Gmail')).rejects.toMatchObject({ status: 409 });
      await expect(createProfile(home, '!!!')).rejects.toMatchObject({ status: 400 });
      const list = await listProfiles(home, (id) => id === 'work-gmail');
      expect(list.map((x) => x.id)).toEqual(['main', 'work-gmail']);
      expect(list[1]).toMatchObject({ exists: true, running: true, name: 'Work Gmail' });
      await expect(deleteProfile(home, 'work-gmail', () => true)).rejects.toMatchObject({
        status: 409,
      });
      await deleteProfile(home, 'work-gmail', () => false);
      await expect(stat(profileDir(home, 'work-gmail'))).rejects.toBeDefined();
      await expect(deleteProfile(home, 'work-gmail', () => false)).rejects.toMatchObject({
        status: 404,
      });
      await expect(deleteProfile(home, '../..', () => false)).rejects.toMatchObject({
        status: 400,
      });
    });
    it('openForUser launches headed for the user and rejects temp', async () => {
      await c.openForUser('main');
      expect(launches[0]).toMatchObject({ forUser: true });
      expect(c.isRunning('main')).toBe(true);
      await expect(c.openForUser('temp')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('read, find, frames', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it('read returns capped markdown, scoped by ref/frame', async () => {
      page().readText = { markdown: 'x', truncated: true };
      const r = await c.run(A, { op: 'read' });
      expect(r).toMatchObject({ ok: true, text: 'x', truncated: true });
      expect(page().calls).toContain('read   12000');
      expect(await c.run(A, { op: 'read', ref: 'e1' })).toMatchObject({ ok: false });
      await snap();
      await c.run(A, { op: 'read', ref: 'e1' });
      expect(page().calls).toContain('read e1  12000');
    });
    it('find returns up to 20 matching refs', async () => {
      page().elements = Array.from({ length: 30 }, (_, i) =>
        el({ ref: `e${i + 1}`, name: `Buy ${i}` })
      );
      const r = await c.run(A, { op: 'find', text: 'buy' });
      expect(r.total).toBe(30);
      expect(r.matches as unknown[]).toHaveLength(20);
      expect(await c.run(A, { op: 'find' })).toMatchObject({ ok: false });
    });
    it('snapshot lists frames and scopes refs to the frame', async () => {
      page().frameList = [
        { index: 0, name: '', url: 'main' },
        { index: 1, name: 'pay', url: 'frame' },
      ];
      page().elements = [el({ ref: 'e1', role: 'textbox', name: 'Name' })];
      const s = await c.run(A, { op: 'snapshot', frame: 'pay' });
      expect(s.frames).toHaveLength(2);
      expect(s.outline).toEqual(['e1 textbox "Name" @pay']);
      expect(page().frameSeen.at(-1)).toBe('pay');
      expect(await c.run(A, { op: 'fill', ref: 'e1', text: 'Ann' })).toMatchObject({ ok: false });
      expect(await c.run(A, { op: 'fill', ref: 'e1', frame: 'pay', text: 'Ann' })).toMatchObject({
        ok: true,
      });
      expect(page().calls).toContain('fill e1 Ann pay');
    });
  });

  describe('field ops', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it('fill refuses secure fields, clear works, type appends', async () => {
      await snap(A, [
        el({ ref: 'e1', role: 'textbox', name: 'Password', type: 'password' }),
        el({ ref: 'e2', role: 'textbox', name: 'Search' }),
        el({ ref: 'e3', role: 'checkbox', name: 'Agree' }),
        el({ ref: 'e4', role: 'button', name: 'Go' }),
      ]);
      expect(await c.run(A, { op: 'fill', ref: 'e1', text: 'x' })).toMatchObject({ ok: false });
      expect(await c.run(A, { op: 'fill', ref: 'e2', text: 'hi' })).toMatchObject({ ok: true });
      expect(await c.run(A, { op: 'clear', ref: 'e2' })).toMatchObject({ ok: true });
      expect(page().calls).toEqual(expect.arrayContaining(['fill e2 hi ', 'clear e2']));
    });
    it('check / uncheck are state-aware and role-checked', async () => {
      await snap(A, [
        el({ ref: 'e1', role: 'checkbox', name: 'Agree' }),
        el({ ref: 'e2', name: 'Go' }),
      ]);
      expect(await c.run(A, { op: 'check', ref: 'e1' })).toMatchObject({ ok: true, changed: true });
      expect(await c.run(A, { op: 'check', ref: 'e1' })).toMatchObject({
        ok: true,
        changed: false,
      });
      expect(await c.run(A, { op: 'uncheck', ref: 'e1' })).toMatchObject({ changed: true });
      expect(await c.run(A, { op: 'check', ref: 'e2' })).toMatchObject({ ok: false });
    });
  });

  describe('pointer extras', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
      await snap(A, [el({ ref: 'e1', name: 'Item' }), el({ ref: 'e2', name: 'Send now' })]);
    });
    it('passes modifiers, button and double; rejects bad modifiers; keeps the danger gate', async () => {
      await c.run(A, {
        op: 'click',
        ref: 'e1',
        button: 'right',
        double: true,
        modifiers: ['ctrl', 'shift'],
      });
      expect(page().calls.at(-1)).toContain(
        '"button":"right","double":true,"modifiers":["Control","Shift"]'
      );
      expect(await c.run(A, { op: 'click', ref: 'e1', modifiers: ['hyper'] })).toMatchObject({
        ok: false,
      });
      expect(await c.run(A, { op: 'click', ref: 'e2', modifiers: ['ctrl'] })).toMatchObject({
        needsApproval: true,
      });
    });
    it('drag path waypoints are validated and capped', async () => {
      const ok = await c.run(A, {
        op: 'drag',
        from: 'e1',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      });
      expect(ok).toMatchObject({ ok: true, strategy: 'path' });
      expect(page().calls).toContain('dragPath 2');
      const many = Array.from({ length: 51 }, () => ({ x: 1, y: 1 }));
      expect(await c.run(A, { op: 'drag', path: many })).toMatchObject({ ok: false });
      expect(
        await c.run(A, {
          op: 'drag',
          path: [
            { x: -1, y: 0 },
            { x: 1, y: 1 },
          ],
        })
      ).toMatchObject({ ok: false });
    });
    it('mouse op validates and gates mouse down on dangerous targets', async () => {
      expect(await c.run(A, { op: 'mouse', action: 'move' })).toMatchObject({ ok: false });
      expect(await c.run(A, { op: 'mouse', action: 'move', x: 5, y: 6 })).toMatchObject({
        ok: true,
      });
      expect(await c.run(A, { op: 'mouse', action: 'wheel', dy: 99999 })).toMatchObject({
        ok: true,
      });
      page().elements = [el({ ref: '', name: 'Delete all' })];
      expect(await c.run(A, { op: 'mouse', action: 'down' })).toMatchObject({
        needsApproval: true,
      });
      expect(await c.run(A, { op: 'mouse', action: 'down', approved: true })).toMatchObject({
        ok: true,
      });
      expect(await c.run(A, { op: 'mouse', action: 'up' })).toMatchObject({ ok: true });
    });
  });

  describe('setEmotion', () => {
    it('sets the emotion on the agent active page, and skips with no page or SNAGLET_BROWSER_CURSOR=0', async () => {
      await c.setEmotion(A.id, 'curious', 3500);
      expect(ctxs).toHaveLength(0);
      await c.run(A, { op: 'open', url: 'https://example.com/' });
      await c.setEmotion(A.id, 'curious', 3500);
      expect(page().emotions).toEqual([{ emotion: 'curious', ttlMs: 3500 }]);
      env.SNAGLET_BROWSER_CURSOR = '0';
      await c.setEmotion(A.id, 'thinking', 3500);
      expect(page().emotions).toHaveLength(1);
      await c.setEmotion('test-agent-z', 'thinking', 3500);
      expect(page().emotions).toHaveLength(1);
    });
  });

  describe('flower driving', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
      await snap(A, [
        el({ ref: 'e1', name: 'Item' }),
        el({ ref: 'e2', role: 'textbox', name: 'Search' }),
        el({ ref: 'e3', role: 'checkbox', name: 'Agree' }),
        el({ ref: 'e4', name: 'Send now' }),
      ]);
    });
    it('moves the flower with the op state and reason before pointer and keyboard ops', async () => {
      page().flowers.length = 0;
      await c.run(A, { op: 'click', ref: 'e1', reason: 'open it' });
      await c.run(A, { op: 'hover', ref: 'e1' });
      await c.run(A, { op: 'fill', ref: 'e2', text: 'a', reason: 'search' });
      await c.run(A, { op: 'check', ref: 'e3' });
      await c.run(A, { op: 'drag', from: 'e1', to: 'e2' });
      const f = page().flowers;
      expect(f[0]).toMatchObject({ state: 'click', label: 'open it', t: { ref: 'e1' } });
      expect(f.map((x) => x.state)).toEqual(['click', 'move', 'move', 'click', 'drag']);
    });
    it('does not move the flower for a refused or gated action', async () => {
      const before = page().flowers.length;
      await c.run(A, { op: 'click', ref: 'e4' });
      expect(page().flowers.length).toBe(before);
    });
    describe('stumped error flower', () => {
      const flush = () => new Promise((r) => setTimeout(r, 0));
      const errs = () => page().flowers.filter((f) => f.state === 'error');
      it('a failed op moves the flower once with state error and the trimmed error', async () => {
        page().flowers.length = 0;
        const r = await c.run(A, { op: 'click', ref: 'nope' });
        await flush();
        expect(r).toMatchObject({ ok: false });
        expect(errs()).toHaveLength(1);
        expect(errs()[0].t).toBeUndefined();
        expect(errs()[0].label).toBe(String(r.error).trim().slice(0, 160));
        expect((page().avatars.at(-1) as { avatarStumped?: string }).avatarStumped).toMatch(
          /^data:image\/svg\+xml;base64,/
        );
      });
      it('trims a long error to 160 chars', async () => {
        page().flowers.length = 0;
        await c.run(A, { op: 'click', ref: 'x'.repeat(500) });
        await flush();
        expect(errs()[0].label?.length).toBeLessThanOrEqual(160);
      });
      it('does not fire for ok, needsApproval or a gated click', async () => {
        page().flowers.length = 0;
        await c.run(A, { op: 'click', ref: 'e1' });
        await c.run(A, { op: 'click', ref: 'e4' });
        await flush();
        expect(errs()).toHaveLength(0);
      });
      it('does not fire for denial, timeout, cancel or interrupt replies', async () => {
        const run = c as unknown as {
          failureText(o: Record<string, unknown>): string | undefined;
        };
        for (const flag of ['denied', 'timedOut', 'cancelled', 'interrupted', 'needsApproval']) {
          expect(run.failureText({ ok: false, error: 'x', message: 'y', [flag]: true })).toBe(
            undefined
          );
        }
        expect(run.failureText({ ok: false, message: 'only a message' })).toBe(undefined);
        expect(run.failureText({ ok: true, error: 'x' })).toBe(undefined);
      });
      it('a throwing flower on failure does not change the reply', async () => {
        page().flower = async () => {
          throw new Error('boom');
        };
        expect(await c.run(A, { op: 'click', ref: 'nope' })).toMatchObject({ ok: false });
        await flush();
      });
    });
    it('a failing flower never blocks the action', async () => {
      page().flower = async () => {
        throw new Error('boom');
      };
      expect(await c.run(A, { op: 'click', ref: 'e1' })).toMatchObject({ ok: true });
    });
  });

  describe('batch', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
      await snap(A, [
        el({ ref: 'e1', role: 'textbox', name: 'Search' }),
        el({ ref: 'e2', role: 'textbox', name: 'Password', type: 'password' }),
        el({ ref: 'e3', name: 'Send' }),
      ]);
    });
    it('runs steps in order and returns compact results', async () => {
      const r = await c.run(A, {
        op: 'batch',
        steps: [
          { op: 'fill', ref: 'e1', text: 'a' },
          { op: 'press', key: 'Tab' },
        ],
      });
      expect(r).toMatchObject({ ok: true });
      expect((r.steps as unknown[]).length).toBe(2);
    });
    it('stops at the first failure or approval, applying gates per step', async () => {
      const bad = await c.run(A, {
        op: 'batch',
        steps: [
          { op: 'fill', ref: 'e2', text: 'x' },
          { op: 'press', key: 'Tab' },
        ],
      });
      expect(bad).toMatchObject({ ok: false, failedAt: 0 });
      expect((bad.steps as unknown[]).length).toBe(1);
      const gate = await c.run(A, {
        op: 'batch',
        steps: [
          { op: 'click', ref: 'e3' },
          { op: 'press', key: 'Tab' },
        ],
      });
      expect(gate).toMatchObject({ ok: false, needsApproval: true, failedAt: 0 });
      const ok = await c.run(A, {
        op: 'batch',
        steps: [{ op: 'click', ref: 'e3', approved: true }],
      });
      expect(ok).toMatchObject({ ok: true });
    });
    it('rejects nesting, open/close/handoff, empty and oversized batches', async () => {
      for (const op of ['batch', 'open', 'close', 'handoff']) {
        expect(await c.run(A, { op: 'batch', steps: [{ op }] })).toMatchObject({ ok: false });
      }
      expect(await c.run(A, { op: 'batch', steps: [] })).toMatchObject({ ok: false });
      const many = Array.from({ length: 16 }, () => ({ op: 'press', key: 'Tab' }));
      expect(await c.run(A, { op: 'batch', steps: many })).toMatchObject({ ok: false });
    });
  });

  describe('press: taps and held keys', () => {
    const keyCalls = () =>
      page().calls.filter((x) => x.startsWith('press') || x.startsWith('hold'));
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });

    it('a press without hold_ms stays a single tap, chords included', async () => {
      for (const key of ['a', 'Enter', 'Control+a']) {
        expect(await c.run(A, { op: 'press', key })).toEqual({ ok: true });
      }
      expect(keyCalls()).toEqual(['press a', 'press Enter', 'press Control+a']);
    });

    it('holds one key or several together for hold_ms', async () => {
      expect(await c.run(A, { op: 'press', key: 'd', hold_ms: 500 })).toEqual({
        ok: true,
        held: ['d'],
        ms: 500,
      });
      expect(await c.run(A, { op: 'press', keys: ['w', 'd'], hold_ms: 250 })).toEqual({
        ok: true,
        held: ['w', 'd'],
        ms: 250,
      });
      expect(keyCalls()).toEqual(['hold d 500', 'hold w,d 250']);
    });

    it.each([
      [{ hold_ms: 500 }, /key or keys/],
      [{ keys: ['w'] }, /hold_ms/],
      [{ key: 'd', hold_ms: 5001 }, /hold_ms/],
      [{ key: 'd', hold_ms: 0 }, /hold_ms/],
      [{ keys: ['a', 'b', 'c', 'd', 'e'], hold_ms: 10 }, /1-4/],
      [{ keys: ['w', 'w'], hold_ms: 10 }, /same key/],
      [{ keys: ['w', 'Bogus'], hold_ms: 10 }, /unknown key/],
      [{ key: 'Shift+d', hold_ms: 10 }, /keys:\["Shift","d"\]/],
      [{ keys: ['Tab', 'Enter'], hold_ms: 10 }, /Tab moves focus/],
      [{ keys: ['Tab', 'a'], hold_ms: 10 }, /Tab moves focus/],
    ])('rejects %j before any key goes down', async (extra, error) => {
      const r = await c.run(A, { op: 'press', ...extra });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(error) });
      expect(keyCalls()).toEqual([]);
    });

    it('hands the run’s abort signal to the hold', async () => {
      const ac = new AbortController();
      await c.run(A, { op: 'press', key: 'd', hold_ms: 10 }, { signal: ac.signal });
      expect(page().holdSignals).toEqual([ac.signal]);
    });

    it('reports a stopped, closed or dialog-interrupted hold', async () => {
      page().holdEnd = 'aborted';
      const stopped = await c.run(A, { op: 'press', key: 'd', hold_ms: 10 });
      expect(stopped).toMatchObject({ ok: false, cancelled: true });
      page().holdEnd = 'closed';
      expect(await c.run(A, { op: 'press', key: 'd', hold_ms: 10 })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/closed/),
      });
      page().holdEnd = 'dialog';
      page().beforeKey = () => {
        page().dialogOpen = { type: 'alert', message: 'hi' };
      };
      const d = await c.run(A, { op: 'press', key: 'd', hold_ms: 10 });
      expect(d).toMatchObject({ ok: false, dialog: { type: 'alert', message: 'hi' } });
    });

    it('refuses to start while a dialog is open', async () => {
      page().dialogOpen = { type: 'confirm', message: 'Leave?' };
      const r = await c.run(A, { op: 'press', key: 'd', hold_ms: 10 });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/op:dialog/) });
      expect(keyCalls()).toEqual([]);
    });

    it('refuses any hold in a secret field', async () => {
      page().focused = el({ ref: '', role: 'textbox', name: 'Password', type: 'password' });
      for (const keys of [['a'], ['ArrowRight'], ['Meta', 'v']]) {
        const r = await c.run(A, { op: 'press', keys, hold_ms: 10 });
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/secret/) });
      }
      expect(keyCalls()).toEqual([]);
    });

    it('holding Enter or Space on a dangerous control needs approval', async () => {
      page().focused = el({ ref: '', name: 'Delete account' });
      for (const keys of [['Enter'], ['NumpadEnter'], ['Space'], [' '], ['Shift', 'Enter']]) {
        expect(await c.run(A, { op: 'press', keys, hold_ms: 10 })).toMatchObject({
          needsApproval: true,
        });
      }
      expect(keyCalls()).toEqual([]);
      expect(await c.run(A, { op: 'press', key: 'd', hold_ms: 10 })).toMatchObject({ ok: true });
      const ok = await c.run(A, { op: 'press', key: 'Enter', hold_ms: 10, approved: true });
      expect(ok).toMatchObject({ ok: true });
      expect(keyCalls()).toEqual(['hold d 10', 'hold Enter 10']);
    });

    it('holds only on the agent’s own tab', async () => {
      const r = await c.run(B, { op: 'press', tab: 't1', key: 'd', hold_ms: 10 });
      expect(r).toMatchObject({ ok: false });
      expect(keyCalls()).toEqual([]);
    });

    it('batch: holds run in order under the same rules and signal', async () => {
      const ac = new AbortController();
      const r = await c.run(
        A,
        {
          op: 'batch',
          steps: [
            { op: 'press', key: 'd', hold_ms: 300 },
            { op: 'press', keys: ['w', 'd'], hold_ms: 200 },
            { op: 'press', key: 'Escape' },
          ],
        },
        { signal: ac.signal }
      );
      expect(r).toMatchObject({ ok: true });
      expect(keyCalls()).toEqual(['hold d 300', 'hold w,d 200', 'press Escape']);
      expect(page().holdSignals).toEqual([ac.signal, ac.signal]);
      const bad = await c.run(A, {
        op: 'batch',
        steps: [{ op: 'press', keys: ['w', 'w'], hold_ms: 10 }],
      });
      expect(bad).toMatchObject({ ok: false, failedAt: 0 });
    });

    it('batch: refuses more than 15 s of holding in total before running a step', async () => {
      const steps = Array.from({ length: 4 }, () => ({ op: 'press', key: 'd', hold_ms: 4000 }));
      const r = await c.run(A, { op: 'batch', steps });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/15000/) });
      expect(keyCalls()).toEqual([]);
      // A negative step cannot buy room for the steps before it.
      const offset = [...steps, { op: 'press', key: 'd', hold_ms: -5000 }];
      expect(await c.run(A, { op: 'batch', steps: offset })).toMatchObject({ ok: false });
      expect(keyCalls()).toEqual([]);
      const fits = Array.from({ length: 3 }, () => ({ op: 'press', key: 'd', hold_ms: 5000 }));
      expect(await c.run(A, { op: 'batch', steps: fits })).toMatchObject({ ok: true });
    });

    it('batch: a stopped run runs no further steps', async () => {
      const ac = new AbortController();
      page().beforeKey = () => ac.abort();
      const r = await c.run(
        A,
        {
          op: 'batch',
          steps: [
            { op: 'press', key: 'Tab' },
            { op: 'press', key: 'd', hold_ms: 100 },
          ],
        },
        { signal: ac.signal }
      );
      expect(r).toMatchObject({ ok: false, cancelled: true, failedAt: 1 });
      expect(keyCalls()).toEqual(['press Tab']);
      page().beforeKey = null;
      page().holdEnd = 'aborted';
      const held = await c.run(A, {
        op: 'batch',
        steps: [
          { op: 'press', key: 'd', hold_ms: 100 },
          { op: 'press', key: 'Tab' },
        ],
      });
      expect(held).toMatchObject({ ok: false, cancelled: true, failedAt: 0 });
    });
  });

  describe('handoff', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it('asks the user, returns done / canceled / timedOut', async () => {
      expect(await c.run(A, { op: 'handoff', message: 'Enter the 2FA code' })).toMatchObject({
        ok: true,
        done: true,
      });
      expect(handoffs[0]).toMatchObject({ message: 'Enter the 2FA code', timeoutMs: 600_000 });
      handoffOutcome = 'deny';
      expect(await c.run(A, { op: 'handoff', message: 'x' })).toMatchObject({
        ok: false,
        cancelled: true,
      });
      handoffOutcome = 'timeout';
      env.SNAGLET_BROWSER_HANDOFF_TIMEOUT_MS = '1000';
      expect(await c.run(A, { op: 'handoff', message: 'x' })).toMatchObject({
        ok: false,
        timedOut: true,
      });
      expect(handoffs[2].timeoutMs).toBe(1000);
      expect(await c.run(A, { op: 'handoff' })).toMatchObject({ ok: false });
    });
    it('keeps the browser alive while waiting', async () => {
      env.SNAGLET_BROWSER_IDLE_MS = '1000';
      let release!: () => void;
      const orig = handoffOutcome;
      void orig;
      const driverHandoff = new Promise<'allow'>((r) => {
        release = () => r('allow');
      });
      handoffs.length = 0;
      (
        c as unknown as { deps: { approval: { handoff: () => Promise<string> } } }
      ).deps.approval.handoff = () => driverHandoff;
      const p = c.run(A, { op: 'handoff', message: 'login' });
      await Promise.resolve();
      t += 60_000;
      expect(await c.sweepIdle()).toEqual([]);
      release();
      expect(await p).toMatchObject({ done: true });
    });
  });

  describe('console, network, show, resize', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
    });
    it('buffers messages (cap 50), strips query strings, filters and clears', async () => {
      for (let i = 0; i < 60; i += 1)
        page().consoleCb[0]({ level: i % 2 ? 'warn' : 'error', text: `m${i}` });
      page().netCb[0]({ method: 'GET', url: 'https://a.com/x?token=secret#h', status: 500 });
      const all = await c.run(A, { op: 'console' });
      expect(all.messages as unknown[]).toHaveLength(50);
      const errs = await c.run(A, { op: 'console', level: 'error', clear: true });
      expect((errs.messages as Array<{ level: string }>).every((m) => m.level === 'error')).toBe(
        true
      );
      expect((await c.run(A, { op: 'console' })).messages).toEqual([]);
      const net = await c.run(A, { op: 'network' });
      expect(net.requests).toEqual([{ method: 'GET', url: 'https://a.com/x', status: 500 }]);
    });
    it('show and resize cap sizes', async () => {
      expect(await c.run(A, { op: 'show' })).toMatchObject({ ok: true });
      await c.run(A, { op: 'resize', width: 99999, height: 10 });
      expect(page().calls).toContain('resize 3840x200');
      expect(await c.run(A, { op: 'resize', width: 800 })).toMatchObject({ ok: false });
    });
  });

  describe('profile close, pdf, trace', () => {
    it('close with profile refuses while others have tabs unless force', async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open(A);
      expect(await c.run(B, { op: 'close', profile: 'main' })).toMatchObject({ ok: false });
      expect(c.isRunning('main')).toBe(true);
      expect(await c.run(A, { op: 'close', profile: 'main' })).toMatchObject({
        ok: true,
        closed: true,
      });
      expect(ctxs[0].closed).toBe(true);
      await open(A);
      expect(await c.run(B, { op: 'close', profile: 'main', force: true })).toMatchObject({
        closed: true,
      });
      expect(await c.run(B, { op: 'close', profile: 'nope' })).toMatchObject({
        ok: true,
        closed: false,
      });
      expect(await c.run(B, { op: 'close', profile: '../x' })).toMatchObject({ ok: false });
    });
    it('stopAll (the kill switch) closes every agent tab and keeps the profile running', async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open(A);
      await open(B);
      expect(await c.run(A, { op: 'tabs' })).toMatchObject({ ok: true });
      expect(await c.stopAll()).toBeGreaterThanOrEqual(2);
      // The stopped agent has no tab left to drive.
      expect(await c.run(A, { op: 'navigate', url: 'https://example.com' })).toMatchObject({
        ok: false,
      });
      expect(await c.stopAll()).toBe(0);
    });
    it('pdf writes into the project folder without overwriting', async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open();
      const r = await c.run(A, { op: 'pdf' });
      expect(path.dirname(String(r.path))).toBe(A.cwd);
      const r2 = await c.run(A, { op: 'pdf' });
      expect(r2.path).not.toBe(r.path);
      expect(await readFile(String(r.path), 'utf8')).toBe('pdf');
    });
    it('trace start/stop saves a zip; auto-stops; refused with other agents', async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      await open(A);
      expect(await c.run(A, { op: 'trace', action: 'start' })).toMatchObject({
        ok: true,
        tracing: true,
      });
      expect(await c.run(A, { op: 'trace', action: 'start' })).toMatchObject({ ok: false });
      const stop = await c.run(A, { op: 'trace', action: 'stop' });
      expect(String(stop.path)).toMatch(/trace-\d+\.zip$/);
      await c.run(A, { op: 'trace', action: 'start' });
      timers[0]();
      await Promise.resolve();
      expect(ctxs[0].traces.filter((x) => x.startsWith('stop'))).toHaveLength(2);
      await open(B);
      expect(await c.run(A, { op: 'trace', action: 'start' })).toMatchObject({ ok: false });
    });
  });

  describe('flower glide delay', () => {
    beforeEach(async () => {
      env.SNAGLET_BROWSER_REQUIRE_APPROVAL = '0';
      env.SNAGLET_BROWSER_CURSOR_DELAY_MS = '300';
      await open();
      await snap(A, [
        el({ ref: 'e1', name: 'Item' }),
        el({ ref: 'e2', role: 'textbox', name: 'Search' }),
        el({ ref: 'e3', role: 'checkbox', name: 'Agree' }),
      ]);
      sleeps.length = 0;
    });
    it('opening a tab puts the flower at the page center with no delay', async () => {
      const f = page().flowers[0];
      expect(f).toMatchObject({ t: undefined, state: 'move' });
      expect(sleeps).toEqual([]);
    });
    it('acting ops wait one glide each, with the reason as label', async () => {
      await c.run(A, { op: 'click', ref: 'e1', reason: 'open it' });
      await c.run(A, { op: 'fill', ref: 'e2', text: 'a' });
      await c.run(A, { op: 'check', ref: 'e3' });
      await c.run(A, { op: 'scroll', dy: 100 });
      expect(sleeps).toEqual([300, 300, 300, 300]);
      expect(page().flowers.at(-4)?.label).toBe('open it');
    });
    it('a batch delays once per step, never more', async () => {
      await c.run(A, {
        op: 'batch',
        steps: [
          { op: 'click', ref: 'e1' },
          { op: 'snapshot' },
          { op: 'fill', ref: 'e2', text: 'a' },
        ],
      });
      expect(sleeps).toEqual([300, 300]);
    });
    it('read-only ops never delay; region reads glide without delay', async () => {
      for (const op of ['snapshot', 'read', 'console', 'network', 'screenshot']) {
        await c.run(A, { op });
      }
      await c.run(A, { op: 'find', text: 'item' });
      expect(sleeps).toEqual([]);
      await snap(A, [el({ ref: 'e1', name: 'Item' })]);
      page().flowers.length = 0;
      await c.run(A, { op: 'read', ref: 'e1' });
      await c.run(A, { op: 'screenshot', ref: 'e1' });
      expect(page().flowers).toHaveLength(2);
      expect(sleeps).toEqual([]);
    });
    it('switch shows the flower at center; delay 0 or SNAGLET_BROWSER_CURSOR=0 disables', async () => {
      page().flowers.length = 0;
      await c.run(A, { op: 'switch' });
      expect(page().flowers).toHaveLength(1);
      env.SNAGLET_BROWSER_CURSOR_DELAY_MS = '0';
      await c.run(A, { op: 'click', ref: 'e1' });
      expect(sleeps).toEqual([]);
      env.SNAGLET_BROWSER_CURSOR_DELAY_MS = '300';
      env.SNAGLET_BROWSER_CURSOR = '0';
      page().flowers.length = 0;
      await c.run(A, { op: 'click', ref: 'e1' });
      expect(page().flowers).toHaveLength(0);
      expect(sleeps).toEqual([]);
    });
  });
});
