import path from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { getErrorMessage } from '@snaglet/shared/utils';
import { BROWSER_CURSOR_PAGE_SCRIPT } from '@server/services/McpService/browserCursor/pageScript';
import {
  DEFAULT_PROFILE,
  ProfileError,
  TEMP_PROFILE,
  assertProfileId,
  createProfile,
  deleteProfile,
  listProfiles,
  profileDir,
  touchProfileMeta,
} from './profiles';
import { buildAvatarDataUrls } from './avatarSvg';
import { MAX_BATCH_HOLD_MS, parseHold } from './keyHold';
import { checkSite, hostOf, isDangerous, isSecureField } from './policy';
import type {
  AgentInfo,
  BrowserDriver,
  ConsoleEntry,
  DriverContext,
  DriverPage,
  ElementInfo,
  Engine,
  Modifier,
  NetworkEntry,
  PageAvatar,
  Target,
} from './types';

/** Best-effort cleanup where a failure changes nothing for the caller. */
const quiet = (): undefined => undefined;

const MAX_ELEMENTS = 200;
const MAX_WAIT_MS = 15_000;
const MAX_READ = 12_000;
const MAX_BATCH = 15;
const MAX_PATH = 50;
const MAX_FIND = 20;
const MAX_BUF = 50;
const MAX_TRACE_MS = 5 * 60_000;
const MAX_COORD = 20_000;
const MAX_WHEEL = 5_000;
const CHECKABLE = new Set(['checkbox', 'radio', 'switch']);
const BATCH_BLOCKED = new Set([
  'batch',
  'handoff',
  'open',
  'close',
  'profiles',
  'screenshot',
  'switch',
]);
/** Keys whose press activates a focused button or link. */
const ACTIVATION_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', ' ']);
const MODIFIERS: Record<string, Modifier> = {
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
};
const rk = (frame: string, ref: string) => `${frame}|${ref}`;

/** A path in `dir` that does not exist yet: name, name (1), name (2)... */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (
    let i = 1;
    await stat(candidate).then(
      () => true,
      () => false
    );
    i += 1
  ) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/** Strip query/fragment so tokens in URLs never reach the agent. */
function cleanUrl(u: string): string {
  try {
    const x = new URL(u);
    return short(x.protocol.startsWith('http') ? `${x.origin}${x.pathname}` : `${x.protocol}`);
  } catch {
    return '?';
  }
}
const SESSION_GRANT_NOTE = 'allow-session lasts 30 minutes per profile';

export interface ApprovalPort {
  required(): boolean;
  hasGrant(agentId: string, profile: string): boolean;
  request(i: {
    agentId: string;
    name: string;
    reason?: string;
    flower: string;
    color: string;
    profile: string;
  }): Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>;
  /** Ask the user to finish a step in the browser window (Done = allow, Cancel = deny). */
  handoff(i: {
    agentId: string;
    name: string;
    message: string;
    flower: string;
    color: string;
    timeoutMs: number;
  }): Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>;
}

export interface BrowserControllerDeps {
  driver: BrowserDriver;
  home: () => string;
  now: () => number;
  approval: ApprovalPort;
  log: (line: Record<string, unknown>) => void;
  env: () => NodeJS.ProcessEnv;
  /** Periodic idle sweep; tests pass a no-op. */
  startSweeper: (fn: () => void) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Visible-glide wait; tests inject a recorder. */
  sleep?: (ms: number) => Promise<void>;
  /** The user's workspace theme for the in-page name tag; re-read on every op. Best effort. */
  theme?: () => Promise<CursorTheme | undefined>;
  /** The full workspace palette (token -> color) used to render the avatar; re-read on every op. */
  palette?: () => Promise<Record<string, string>>;
}

export interface CursorTheme {
  background: string;
  text: string;
  border: string;
}

interface Tab {
  id: string;
  agentId: string;
  profile: string;
  page: DriverPage;
  /** Keyed `${frame}|${ref}`. */
  refs: Map<string, ElementInfo>;
  consoleBuf: ConsoleEntry[];
  netBuf: NetworkEntry[];
  mouse: { x: number; y: number };
}

interface Session {
  profile: string;
  ctx: DriverContext;
  tabs: Map<string, Tab>; // key `${agentId}/${tabId}`
  lastUsed: number;
  userHeld: boolean;
  /** Calls in flight that must keep the browser alive (handoff). */
  busy: number;
  trace?: { agentId: string; dest: string; timer: unknown };
}

export type BrowserResult = Record<string, unknown> & { screenshot?: Buffer };
type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const short = (u: string) => (u.length > 200 ? `${u.slice(0, 200)}...` : u);
const fail = (error: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  error,
  ...extra,
});

function engineFromEnv(env: NodeJS.ProcessEnv): Engine {
  const v = (env.SNAGLET_BROWSER_ENGINE ?? 'chrome').toLowerCase();
  return v === 'chromium' || v === 'webkit' ? v : 'chrome';
}

export class BrowserController {
  private sessions = new Map<string, Session>();
  private launching = new Map<string, Promise<Session>>();
  private active = new Map<string, string>(); // agentId -> tabId
  private agents = new Map<string, AgentInfo>(); // last seen identity per agent
  private counters = new Map<string, number>();
  private downloads = new Map<string, Array<{ file: string; name: string }>>();
  private sweeperStarted = false;

  constructor(private readonly deps: BrowserControllerDeps) {}

  // Profiles (routes + tool)

  isRunning = (profile: string) => this.sessions.has(profile);
  list = () => listProfiles(this.deps.home(), this.isRunning);
  create = (name: string) => createProfile(this.deps.home(), name);
  remove = (id: string) => deleteProfile(this.deps.home(), id, this.isRunning);

  /** Sign-in flow: launch the profile headed for the user; agents may share it afterward. */
  async openForUser(id: string): Promise<void> {
    assertProfileId(id);
    if (id === TEMP_PROFILE) throw new ProfileError('"temp" is not a signed-in profile', 400);
    const s = await this.session(id, true);
    s.userHeld = true;
    await s.ctx.ensureWindow();
  }

  // Idle shutdown

  idleMs(): number {
    const n = Number(this.deps.env().SNAGLET_BROWSER_IDLE_MS);
    return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
  }

  /** Close profiles with no calls for the idle window. Returns the closed ids. */
  async sweepIdle(): Promise<string[]> {
    const closed: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.userHeld || s.busy > 0 || this.deps.now() - s.lastUsed < this.idleMs()) continue;
      await this.stopTrace(s).catch(quiet);
      this.dropSession(s.profile);
      await s.ctx.close().catch(quiet);
      closed.push(s.profile);
    }
    return closed;
  }

  /**
   * Kill switch (POST /api/computer/stop): close every agent tab so a stopped agent
   * cannot keep driving a signed-in profile. Profiles the user opened stay running.
   * Returns the number of tabs closed. Never throws.
   */
  async stopAll(): Promise<number> {
    let closed = 0;
    for (const s of [...this.sessions.values()]) {
      for (const [key, t] of [...s.tabs.entries()]) {
        s.tabs.delete(key);
        if (this.active.get(t.agentId) === t.id) this.active.delete(t.agentId);
        await t.page.close().catch(quiet);
        closed += 1;
      }
      if (s.trace) await this.stopTrace(s).catch(quiet);
    }
    return closed;
  }

  async shutdown(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      this.dropSession(s.profile);
      await s.ctx.close().catch(quiet);
    }
  }

  private dropSession(profile: string) {
    const s = this.sessions.get(profile);
    if (!s) return;
    this.sessions.delete(profile);
    for (const t of s.tabs.values()) {
      if (this.active.get(t.agentId) === t.id) this.active.delete(t.agentId);
    }
  }

  private async session(profile: string, forUser: boolean): Promise<Session> {
    const existing = this.sessions.get(profile);
    if (existing) return existing;
    const pending = this.launching.get(profile);
    if (pending) return pending;
    const p = (async () => {
      const env = this.deps.env();
      const engine = engineFromEnv(env);
      if (engine === 'webkit' && profile !== TEMP_PROFILE) {
        throw new Error('SNAGLET_BROWSER_ENGINE=webkit only works with the temp profile');
      }
      const home = this.deps.home();
      const dir = profile === TEMP_PROFILE ? null : profileDir(home, profile);
      if (dir) {
        await mkdir(dir, { recursive: true });
        await touchProfileMeta(home, profile).catch(quiet);
      }
      const ctx = await this.deps.driver.launch({ profileDir: dir, engine, forUser });
      const s: Session = {
        profile,
        ctx,
        tabs: new Map(),
        lastUsed: this.deps.now(),
        userHeld: false,
        busy: 0,
      };
      this.sessions.set(profile, s);
      ctx.onClosed(() => {
        if (this.sessions.get(profile) === s) this.dropSession(profile);
      });
      if (!this.sweeperStarted) {
        this.sweeperStarted = true;
        this.deps.startSweeper(() => void this.sweepIdle());
      }
      return s;
    })().finally(() => this.launching.delete(profile));
    this.launching.set(profile, p);
    return p;
  }

  // The tool entry point

  /** `signal` is the agent run's: aborting it ends a key hold (and a batch) early. */
  async run(
    agent: AgentInfo,
    input: Input,
    opts: { signal?: AbortSignal } = {}
  ): Promise<BrowserResult> {
    const op = str(input.op);
    const env = this.deps.env();
    this.agents.set(agent.id, agent);
    try {
      const out = await this.dispatch(agent, op, input, env, opts.signal);
      this.noteFailure(agent, input, out);
      return out;
    } catch (err) {
      const msg = getErrorMessage(err);
      const tail = msg.split('\n')[0].slice(0, 300);
      const out = /Target page, context or browser has been closed|has been closed/i.test(msg)
        ? fail('The browser was closed. Use op:open to start it again.')
        : fail(tail);
      this.noteFailure(agent, input, out);
      return out;
    }
  }

  /** The error text of a genuine failure reply; undefined for ok, approval, denial, timeout, cancel. */
  private failureText(out: BrowserResult): string | undefined {
    if (out.ok !== false) return undefined;
    if (out.needsApproval || out.denied || out.timedOut || out.cancelled || out.interrupted)
      return undefined;
    let e: unknown = out.error;
    if (typeof e !== 'string' && Array.isArray(out.steps) && typeof out.failedAt === 'number') {
      const step = out.steps[out.failedAt] as { error?: unknown } | undefined;
      e = step?.error;
    }
    return typeof e === 'string' && e.trim() ? e.trim().slice(0, 160) : undefined;
  }

  /**
   * Shows the stumped face with the error in the tag at the flower's last position.
   * Fire and forget: never throws, never delays or alters the reply.
   */
  private noteFailure(agent: AgentInfo, input: Input, out: BrowserResult): void {
    try {
      if (this.deps.env().SNAGLET_BROWSER_CURSOR === '0') return;
      const text = this.failureText(out);
      if (!text) return;
      const t = this.tabOf(agent, input);
      if ('error' in t) return;
      void (async () => {
        try {
          const a = this.agents.get(t.agentId);
          await t.page.flower(
            undefined,
            'error',
            text,
            await this.theme(),
            a ? await this.avatar(a) : undefined
          );
        } catch {
          // decoration only
        }
      })();
    } catch {
      // decoration only
    }
  }

  private log(agent: AgentInfo, op: string, url: string | undefined, extra: Input = {}) {
    this.deps.log({ op, agentId: agent.id, host: url ? hostOf(url) : undefined, ...extra });
  }

  private tabOf(agent: AgentInfo, input: Input): Tab | { error: string } {
    const id = str(input.tab) || this.active.get(agent.id);
    if (!id) return { error: 'You have no open tab. Use op:open with a url first.' };
    for (const s of this.sessions.values()) {
      const t = s.tabs.get(`${agent.id}/${id}`);
      if (t) return t;
    }
    return { error: `You have no tab "${id}". Use op:tabs to list yours.` };
  }

  private myTabs(agent: AgentInfo): Tab[] {
    return [...this.sessions.values()].flatMap((s) =>
      [...s.tabs.values()].filter((t) => t.agentId === agent.id)
    );
  }

  private async dispatch(
    agent: AgentInfo,
    op: string,
    input: Input,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<BrowserResult> {
    if (op === 'profiles') {
      this.log(agent, op, undefined);
      return {
        ok: true,
        profiles: (await this.list()).map((p) => ({
          id: p.id,
          name: p.name,
          exists: p.exists,
          running: p.running,
        })),
        temp: 'Use profile "temp" for an isolated, signed-out browser that is thrown away.',
      };
    }
    if (op === 'open') return this.open(agent, input, env);
    if (op === 'close' && input.profile !== undefined) return this.releaseProfile(agent, input);

    const t = this.tabOf(agent, input);
    if ('error' in t) return fail(t.error);
    const session = this.sessions.get(t.profile);
    if (!session) return fail('The browser was closed. Use op:open to start it again.');
    session.lastUsed = this.deps.now();
    const page = t.page;
    this.log(
      agent,
      op,
      page.url(),
      op === 'type' || op === 'fill' ? { textLength: str(input.text).length } : {}
    );

    if (op === 'tabs') return this.tabsOut(agent);
    if (op === 'switch' || op === 'show') {
      this.active.set(agent.id, t.id);
      await page.bringToFront();
      await this.flower(t, undefined, 'move', input, false);
      return { ok: true, tab: t.id, url: short(page.url()) };
    }
    if (op === 'close') {
      session.tabs.delete(`${agent.id}/${t.id}`);
      if (this.active.get(agent.id) === t.id) this.active.delete(agent.id);
      await page.close().catch(quiet);
      const next = this.myTabs(agent).at(-1);
      if (next) this.active.set(agent.id, next.id);
      return { ok: true, closed: t.id, activeTab: next?.id ?? null };
    }

    const siteErr = checkSite(page.url(), env);
    if (siteErr) return fail(`Blocked: ${siteErr}`);
    this.active.set(agent.id, t.id);

    switch (op) {
      case 'navigate':
        return this.navigate(t, input, env);
      case 'snapshot':
        return this.snapshot(t, str(input.frame));
      case 'read':
        return this.read(t, input);
      case 'find':
        return this.find(t, input);
      case 'screenshot': {
        const r = str(input.ref) ? this.refInfo(t, input) : null;
        if (r && 'error' in r) return fail(r.error);
        if (r)
          await this.flower(t, { ref: r.ref, frame: r.frame || undefined }, 'move', input, false);
        return {
          ok: true,
          screenshot: await page.screenshot(
            r ? { ref: r.ref, frame: r.frame || undefined } : undefined
          ),
          url: short(page.url()),
        };
      }
      case 'click':
      case 'hover':
        return this.pointer(t, op, input);
      case 'drag':
        return this.drag(t, input);
      case 'mouse':
        return this.mouse(t, input);
      case 'type':
      case 'fill':
        return this.typeOrFill(t, op, input);
      case 'clear':
      case 'check':
      case 'uncheck':
        return this.fieldOp(t, op, input);
      case 'press':
        return this.press(t, input, signal);
      case 'select':
        return this.select(t, input);
      case 'upload':
        return this.upload(t, agent, input);
      case 'scroll': {
        const target = this.target(t, input, str(input.frame));
        if (target && 'error' in target) return fail(target.error);
        await this.flower(t, target?.t, 'move', input);
        await page.scroll(target?.t, num(input.dx) ?? 0, num(input.dy) ?? 600);
        return { ok: true };
      }
      case 'wait': {
        const ms = Math.min(MAX_WAIT_MS, Math.max(0, num(input.ms) ?? 1000));
        await page.wait({
          selector: str(input.selector) || undefined,
          text: str(input.text) || undefined,
          ms,
        });
        return { ok: true };
      }
      case 'dialog': {
        const pending = page.pendingDialog();
        const action = str(input.action);
        if (action !== 'accept' && action !== 'dismiss') return { ok: true, dialog: pending };
        if (!pending) return fail('No dialog is open.');
        if (action === 'accept' && isDangerous(pending.message) && input.approved !== true) {
          return this.needsApproval(pending.message.slice(0, 80));
        }
        await page.handleDialog(action === 'accept');
        return { ok: true, handled: pending.type };
      }
      case 'downloads':
        return { ok: true, downloads: this.downloads.get(agent.id) ?? [] };
      case 'console':
      case 'network': {
        const buf = op === 'console' ? t.consoleBuf : t.netBuf;
        const level = str(input.level);
        const items = (buf as Array<ConsoleEntry & NetworkEntry>).filter(
          (e) => op === 'network' || !level || e.level === level
        );
        if (input.clear === true) buf.length = 0;
        return { ok: true, [op === 'console' ? 'messages' : 'requests']: items };
      }
      case 'handoff':
        return this.handoff(agent, t, session, input);
      case 'batch':
        return this.batch(agent, t, input, env, signal);
      case 'pdf':
        return this.pdf(agent, t);
      case 'resize': {
        const w = Math.round(Math.min(3840, Math.max(200, num(input.width) ?? 0)));
        const h = Math.round(Math.min(2160, Math.max(200, num(input.height) ?? 0)));
        if (!num(input.width) || !num(input.height)) return fail('resize needs width and height');
        const sc = num(input.scale);
        await page.resize(w, h, sc ? Math.min(3, Math.max(1, sc)) : undefined);
        t.refs.clear();
        return { ok: true, width: w, height: h };
      }
      case 'trace':
        return this.trace(agent, t, session, input);
      default:
        return fail(`unknown op "${op}"`);
    }
  }

  // Profile release, handoff, batch, trace

  private async releaseProfile(agent: AgentInfo, input: Input): Promise<BrowserResult> {
    let id: string;
    try {
      id = assertProfileId(input.profile);
    } catch (e) {
      return fail(getErrorMessage(e));
    }
    this.log(agent, 'close', undefined, { profile: id });
    const s = this.sessions.get(id);
    if (!s) return { ok: true, closed: false, note: `profile "${id}" is not running` };
    const others = new Set(
      [...s.tabs.values()].filter((x) => x.agentId !== agent.id).map((x) => x.agentId)
    );
    if ((others.size > 0 || s.userHeld) && input.force !== true) {
      return fail(
        `profile "${id}" is in use ${s.userHeld ? 'by the user' : `by ${others.size} other agent(s)`}; close only your tabs, or pass force:true if the user asked for it.`
      );
    }
    await this.stopTrace(s).catch(quiet);
    this.dropSession(id);
    await s.ctx.close().catch(quiet);
    return { ok: true, closed: true };
  }

  private async handoff(
    agent: AgentInfo,
    t: Tab,
    session: Session,
    input: Input
  ): Promise<BrowserResult> {
    const message = str(input.message).trim();
    if (!message) return fail('handoff needs message: the step the user should finish');
    await t.page.bringToFront();
    session.busy += 1;
    try {
      const outcome = await this.deps.approval.handoff({
        agentId: agent.id,
        name: agent.name,
        message: message.slice(0, 300),
        flower: agent.flower,
        color: agent.color,
        timeoutMs: this.handoffTimeoutMs(),
      });
      t.refs.clear();
      if (outcome === 'allow' || outcome === 'allow-session') return { ok: true, done: true };
      if (outcome === 'deny') {
        return { ok: false, cancelled: true, message: 'The user canceled the handoff.' };
      }
      return { ok: false, timedOut: true, message: 'The user did not finish the step in time.' };
    } finally {
      session.busy -= 1;
      session.lastUsed = this.deps.now();
    }
  }

  handoffTimeoutMs(): number {
    const n = Number(this.deps.env().SNAGLET_BROWSER_HANDOFF_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
  }

  private async batch(
    agent: AgentInfo,
    t: Tab,
    input: Input,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<BrowserResult> {
    const steps = Array.isArray(input.steps) ? (input.steps as unknown[]) : [];
    if (steps.length === 0 || steps.length > MAX_BATCH) {
      return fail(`batch needs 1-${MAX_BATCH} steps`);
    }
    const holdMs = steps.reduce<number>((sum, s) => {
      const step = (s ?? {}) as Input;
      return sum + (step.op === 'press' ? Math.max(0, num(step.hold_ms) ?? 0) : 0);
    }, 0);
    if (holdMs > MAX_BATCH_HOLD_MS) {
      return fail(`batch holds keys for ${holdMs} ms in total; the limit is ${MAX_BATCH_HOLD_MS}`);
    }
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (signal?.aborted) {
        return { ok: false, cancelled: true, failedAt: i, steps: results };
      }
      const step = steps[i] as Input;
      const op = step && typeof step === 'object' ? str(step.op) : '';
      if (!op) return { ...fail(`step ${i} has no op`), steps: results };
      if (BATCH_BLOCKED.has(op)) {
        return { ...fail(`step ${i}: "${op}" is not allowed inside batch`), steps: results };
      }
      const r = await this.dispatch(agent, op, { ...step, tab: t.id }, env, signal).catch(
        (e): BrowserResult => fail(getErrorMessage(e).split('\n')[0].slice(0, 300))
      );
      const { screenshot: _s, ok, ...rest } = r;
      results.push({ i, op, ok, ...rest });
      if (ok !== true) {
        return {
          ok: false,
          failedAt: i,
          ...(r.needsApproval ? { needsApproval: true, message: r.message } : {}),
          ...(r.cancelled ? { cancelled: true } : {}),
          steps: results,
        };
      }
    }
    return { ok: true, steps: results };
  }

  private async stopTrace(s: Session, atPath?: string): Promise<string | null> {
    const tr = s.trace;
    if (!tr) return null;
    s.trace = undefined;
    this.deps.clearTimer?.(tr.timer);
    const dest = atPath ?? tr.dest;
    await s.ctx.traceStop(dest);
    return dest;
  }

  private async trace(agent: AgentInfo, t: Tab, s: Session, input: Input): Promise<BrowserResult> {
    const action = str(input.action);
    if (action === 'start') {
      if (s.trace) return fail('A trace is already running for this profile.');
      const others = [...s.tabs.values()].some((x) => x.agentId !== agent.id);
      if (others) {
        return fail(
          'Tracing records the whole profile; refused while other agents have tabs open.'
        );
      }
      const dest = await uniquePath(this.outDir(agent), `trace-${this.deps.now()}.zip`);
      await s.ctx.traceStart();
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const timer = setTimer(() => {
        void this.stopTrace(s).catch(quiet);
      }, MAX_TRACE_MS);
      s.trace = { agentId: agent.id, dest, timer };
      return { ok: true, tracing: true, maxMinutes: MAX_TRACE_MS / 60_000 };
    }
    if (action === 'stop') {
      if (!s.trace) return fail('No trace is running (it stops by itself after 5 minutes).');
      if (s.trace.agentId !== agent.id) return fail('That trace belongs to another agent.');
      const dest = await this.stopTrace(s);
      return { ok: true, path: dest };
    }
    void t;
    return fail('trace needs action: start or stop');
  }

  private outDir(agent: AgentInfo) {
    return agent.cwd ?? path.join(this.deps.home(), 'downloads');
  }

  private async pdf(agent: AgentInfo, t: Tab): Promise<BrowserResult> {
    const dir = this.outDir(agent);
    await mkdir(dir, { recursive: true });
    const dest = await uniquePath(dir, `page-${this.deps.now()}.pdf`);
    await t.page.pdf(dest);
    return { ok: true, path: dest };
  }

  private async open(
    agent: AgentInfo,
    input: Input,
    env: NodeJS.ProcessEnv
  ): Promise<BrowserResult> {
    const profile = input.profile === undefined ? DEFAULT_PROFILE : String(input.profile);
    try {
      assertProfileId(profile);
    } catch (e) {
      return fail(getErrorMessage(e));
    }
    const url = str(input.url) || 'about:blank';
    this.log(agent, 'open', url, { profile });
    const siteErr = checkSite(url, env);
    if (siteErr) return fail(`Blocked: ${siteErr}`);

    const session = this.sessions.get(profile);
    const hasTabs =
      session !== undefined && [...session.tabs.values()].some((t) => t.agentId === agent.id);
    if (
      profile !== TEMP_PROFILE &&
      !hasTabs &&
      this.deps.approval.required() &&
      !this.deps.approval.hasGrant(agent.id, profile)
    ) {
      const outcome = await this.deps.approval.request({
        agentId: agent.id,
        name: agent.name,
        reason: str(input.reason) || undefined,
        flower: agent.flower,
        color: agent.color,
        profile,
      });
      if (outcome === 'deny') {
        return {
          ok: false,
          denied: true,
          message: `The user did not allow browser use of profile "${profile}". Do not ask again unless they invite you to. You may use profile "temp" (signed out).`,
        };
      }
      if (outcome === 'timeout') {
        return {
          ok: false,
          timedOut: true,
          message: 'No answer from the user. Try again later or ask them in chat.',
        };
      }
    }

    const s = await this.session(profile, false);
    s.lastUsed = this.deps.now();
    const page = await s.ctx.newPage();
    const n = (this.counters.get(agent.id) ?? 0) + 1;
    this.counters.set(agent.id, n);
    const tab: Tab = {
      id: `t${n}`,
      agentId: agent.id,
      profile,
      page,
      refs: new Map(),
      consoleBuf: [],
      netBuf: [],
      mouse: { x: 0, y: 0 },
    };
    s.tabs.set(`${agent.id}/${tab.id}`, tab);
    this.active.set(agent.id, tab.id);
    page.onNavigated(() => tab.refs.clear());
    page.onClosed(() => {
      s.tabs.delete(`${agent.id}/${tab.id}`);
      if (this.active.get(agent.id) === tab.id) this.active.delete(agent.id);
    });
    page.onConsole((e) => {
      tab.consoleBuf.push({ level: e.level, text: e.text.slice(0, 300) });
      if (tab.consoleBuf.length > MAX_BUF) tab.consoleBuf.shift();
    });
    page.onNetwork((e) => {
      tab.netBuf.push({ ...e, url: cleanUrl(e.url) });
      if (tab.netBuf.length > MAX_BUF) tab.netBuf.shift();
    });
    page.onDownload((d) => void this.saveDownload(agent, d));
    await this.installCursor(agent, page);
    if (url !== 'about:blank') {
      await page.goto(url);
      const after = checkSite(page.url(), env);
      if (after) {
        await page.goto('about:blank').catch(quiet);
        return fail(`Blocked after redirect: ${after}`, { tab: tab.id });
      }
    }
    await this.flower(tab, undefined, 'move', input, false);
    return {
      ok: true,
      tab: tab.id,
      profile,
      url: short(page.url()),
      title: await page.title().catch(() => ''),
      ...(s.ctx.note ? { note: s.ctx.note } : {}),
      ...(this.deps.approval.required() && profile !== TEMP_PROFILE
        ? { grantNote: SESSION_GRANT_NOTE }
        : {}),
    };
  }

  /**
   * Shows `emotion` on the agent's active page flower for ttlMs without moving it
   * ('neutral' clears). Silent no-op without an open page or when SNAGLET_BROWSER_CURSOR=0.
   */
  async setEmotion(agentId: string, emotion: string, ttlMs: number): Promise<void> {
    try {
      if (this.deps.env().SNAGLET_BROWSER_CURSOR === '0') return;
      const id = this.active.get(agentId);
      if (!id) return;
      for (const s of this.sessions.values()) {
        const t = s.tabs.get(`${agentId}/${id}`);
        if (t) return await t.page.setEmotion(emotion, ttlMs);
      }
    } catch {
      // decoration only
    }
  }

  private async installCursor(agent: AgentInfo, page: DriverPage) {
    if (this.deps.env().SNAGLET_BROWSER_CURSOR === '0') return;
    const theme = await this.theme();
    const av = await this.avatar(agent);
    const identity = JSON.stringify({
      flower: agent.flower,
      color: agent.color,
      name: agent.name || 'Agent',
      ...(theme ? { theme } : {}),
      ...(av ?? {}),
    }).replace(/</g, '\\u003c');
    await page
      .installCursor(`window.__snagletAgentCursor = ${identity};\n${BROWSER_CURSOR_PAGE_SCRIPT}`)
      .catch(quiet);
  }

  /** The avatar data URL and its petal color for the page; undefined when unavailable. */
  private async avatar(agent: AgentInfo): Promise<PageAvatar | undefined> {
    try {
      const spec = agent.cursorSpec;
      const palette = await this.deps.palette?.();
      if (!spec || !palette) return undefined;
      const urls = buildAvatarDataUrls(spec, palette);
      const avatar = urls?.neutral;
      const avatarStumped = urls?.stumped;
      const ring = palette[spec.colors.petal];
      const ringColor = typeof ring === 'string' && /^#[0-9a-f]{6}$/i.test(ring) ? ring : undefined;
      if (!avatar && !ringColor) return undefined;
      return {
        ...(avatar ? { avatar } : {}),
        ...(avatarStumped ? { avatarStumped } : {}),
        ...(urls ? { avatars: { ...urls } } : {}),
        ...(ringColor ? { ringColor } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async theme(): Promise<CursorTheme | undefined> {
    try {
      const t = await this.deps.theme?.();
      return t ? { background: t.background, text: t.text, border: t.border } : undefined;
    } catch {
      return undefined;
    }
  }

  private tabsOut(agent: AgentInfo): BrowserResult {
    const act = this.active.get(agent.id);
    return {
      ok: true,
      tabs: this.myTabs(agent).map((t) => ({
        id: t.id,
        profile: t.profile,
        url: short(t.page.url()),
        active: t.id === act,
      })),
    };
  }

  private async navigate(t: Tab, input: Input, env: NodeJS.ProcessEnv): Promise<BrowserResult> {
    const to = str(input.to);
    if (to === 'back' || to === 'forward' || to === 'reload') {
      await t.page.nav(to);
    } else {
      const url = str(input.url);
      if (!url) return fail('navigate needs url or to: back|forward|reload');
      const err = checkSite(url, env);
      if (err) return fail(`Blocked: ${err}`);
      await t.page.goto(url);
    }
    t.refs.clear();
    const after = checkSite(t.page.url(), env);
    if (after) {
      await t.page.goto('about:blank').catch(quiet);
      return fail(`Blocked after redirect: ${after}`);
    }
    return { ok: true, url: short(t.page.url()), title: await t.page.title().catch(() => '') };
  }

  private async collectRefs(t: Tab, frame: string) {
    const { elements, truncated } = await t.page.collect(MAX_ELEMENTS, frame || undefined);
    t.refs = new Map(elements.map((e) => [rk(frame, e.ref), { ...e, frame }]));
    return { elements, truncated };
  }

  private line(e: ElementInfo, frame: string): string {
    const secure = isSecureField(e);
    let line = `${e.ref} ${e.role}${e.name ? ` "${e.name}"` : ''}`;
    if (e.value && !secure) line += ` =${JSON.stringify(e.value)}`;
    if (secure) line += ' [secret field: user types this]';
    if (e.checked) line += ' [checked]';
    if (e.disabled) line += ' [disabled]';
    if (frame) line += ` @${frame}`;
    return line;
  }

  private async snapshot(t: Tab, frame: string): Promise<BrowserResult> {
    const { elements, truncated } = await this.collectRefs(t, frame);
    const frames = t.page.frames();
    return {
      ok: true,
      tab: t.id,
      url: short(t.page.url()),
      title: await t.page.title().catch(() => ''),
      ...(frames.length > 1 ? { frames } : {}),
      count: elements.length,
      truncated,
      outline: elements.map((e) => this.line(e, frame)),
    };
  }

  private async find(t: Tab, input: Input): Promise<BrowserResult> {
    const text = str(input.text).trim().toLowerCase();
    if (!text) return fail('find needs text');
    const frame = str(input.frame);
    const { elements } = await this.collectRefs(t, frame);
    const hits = elements.filter((e) => `${e.name} ${e.value ?? ''}`.toLowerCase().includes(text));
    return {
      ok: true,
      note: 'refs were refreshed',
      total: hits.length,
      matches: hits.slice(0, MAX_FIND).map((e) => this.line(e, frame)),
    };
  }

  private async read(t: Tab, input: Input): Promise<BrowserResult> {
    const frame = str(input.frame);
    const ref = str(input.ref);
    if (ref) {
      const r = this.refInfo(t, input);
      if ('error' in r) return fail(r.error);
      await this.flower(t, { ref, frame: frame || undefined }, 'move', input, false);
    }
    const out = await t.page.read({
      ref: ref || undefined,
      frame: frame || undefined,
      max: MAX_READ,
    });
    return {
      ok: true,
      url: short(t.page.url()),
      title: await t.page.title().catch(() => ''),
      truncated: out.truncated,
      text: out.markdown,
    };
  }

  private stale = (ref: string, frame = '') =>
    `ref ${ref}${frame ? ` (frame ${frame})` : ''} is unknown or stale: call op:snapshot${frame ? ` with frame:"${frame}"` : ''} and use a fresh ref`;

  private refInfo(
    t: Tab,
    input: Input
  ): { ref: string; frame: string; info: ElementInfo } | { error: string } {
    const ref = str(input.ref);
    const frame = str(input.frame);
    if (!ref) return { error: 'needs ref' };
    const info = t.refs.get(rk(frame, ref));
    return info ? { ref, frame, info } : { error: this.stale(ref, frame) };
  }

  /** ref | x,y -> a Target, or undefined when neither was given. */
  private target(
    t: Tab,
    spec: Input,
    frame: string
  ): { t: Target; info?: ElementInfo } | { error: string } | undefined {
    const ref = str(spec.ref);
    if (ref) {
      const info = t.refs.get(rk(frame, ref));
      return info
        ? { t: { ref, ...(frame ? { frame } : {}) }, info }
        : { error: this.stale(ref, frame) };
    }
    const x = num(spec.x);
    const y = num(spec.y);
    if (x !== undefined && y !== undefined && x >= 0 && y >= 0) return { t: { x, y } };
    return undefined;
  }

  cursorDelayMs(): number {
    const n = Number(this.deps.env().SNAGLET_BROWSER_CURSOR_DELAY_MS);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : 300;
  }

  /**
   * Drives the agent's flower to the target (page script only; never the OS cursor)
   * and, for acting ops, waits one short visible glide. Never blocks or fails the op.
   */
  private async flower(
    t: Tab,
    target: Target | undefined,
    state: 'move' | 'click' | 'drag',
    input: Input,
    wait = true
  ): Promise<void> {
    if (this.deps.env().SNAGLET_BROWSER_CURSOR === '0') return;
    try {
      const agent = this.agents.get(t.agentId);
      await t.page.flower(
        target,
        state,
        str(input.reason) || undefined,
        await this.theme(),
        agent ? await this.avatar(agent) : undefined
      );
      const ms = this.cursorDelayMs();
      if (wait && ms > 0)
        await (this.deps.sleep ?? ((d) => new Promise((r) => setTimeout(r, d))))(ms);
    } catch {
      // decoration only
    }
  }

  private needsApproval(label: string): BrowserResult {
    return {
      ok: false,
      needsApproval: true,
      message: `"${label}" looks like a consequential control. Use the ask tool to get the user's answer first; only after they say yes, repeat this call with approved:true. Do not act until then.`,
    };
  }

  private async nameAt(t: Tab, r: { t: Target; info?: ElementInfo }): Promise<string> {
    if (r.info) return r.info.name;
    if ('x' in r.t) return (await t.page.describeAt(r.t.x, r.t.y))?.name ?? '';
    return '';
  }

  private mods(input: Input): Modifier[] | { error: string } {
    if (input.modifiers === undefined) return [];
    if (!Array.isArray(input.modifiers)) return { error: 'modifiers must be an array' };
    const out: Modifier[] = [];
    for (const m of input.modifiers) {
      const k = MODIFIERS[String(m).toLowerCase()];
      if (!k) return { error: `unknown modifier "${String(m)}": use ctrl, shift, alt, meta` };
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  private async pointer(t: Tab, op: 'click' | 'hover', input: Input): Promise<BrowserResult> {
    const r = this.target(t, input, str(input.frame));
    if (!r) return fail('give ref or x and y');
    if ('error' in r) return fail(r.error);
    const modifiers = this.mods(input);
    if ('error' in modifiers) return fail(modifiers.error);
    if (op === 'hover') {
      await this.flower(t, r.t, 'move', input);
      await t.page.hover(r.t, modifiers);
      return { ok: true };
    }
    const name = await this.nameAt(t, r);
    if (isDangerous(name) && input.approved !== true) return this.needsApproval(name);
    const b = str(input.button);
    await this.flower(t, r.t, 'click', input);
    await t.page.click(r.t, {
      button: b === 'right' || b === 'middle' ? b : 'left',
      double: input.double === true,
      modifiers,
    });
    return { ok: true, ...this.dialogHint(t) };
  }

  private dialogHint(t: Tab) {
    const d = t.page.pendingDialog();
    return d ? { dialog: d } : {};
  }

  private async drag(t: Tab, input: Input): Promise<BrowserResult> {
    const frame = str(input.frame);
    const spec = (v: unknown): Input => (typeof v === 'string' ? { ref: v } : ((v as Input) ?? {}));
    const modifiers = this.mods(input);
    if ('error' in modifiers) return fail(modifiers.error);
    const f = input.from === undefined ? undefined : this.target(t, spec(input.from), frame);
    if (f && 'error' in f) return fail(`from: ${f.error}`);
    if (f && input.approved !== true) {
      const fromName = await this.nameAt(t, f);
      if (isDangerous(fromName)) return this.needsApproval(fromName);
    }
    if (input.path !== undefined) {
      const pts = Array.isArray(input.path) ? (input.path as unknown[]) : [];
      if (pts.length < 1 || pts.length > MAX_PATH) return fail(`path needs 1-${MAX_PATH} points`);
      const path: Array<{ x: number; y: number }> = [];
      for (const p of pts) {
        const x = num((p as Input)?.x);
        const y = num((p as Input)?.y);
        if (
          x === undefined ||
          y === undefined ||
          x < 0 ||
          y < 0 ||
          x > MAX_COORD ||
          y > MAX_COORD
        ) {
          return fail('path points must be {x,y} with 0 <= x,y <= 20000');
        }
        path.push({ x, y });
      }
      if (!f && path.length < 2) return fail('path without from needs at least 2 points');
      await this.flower(t, f?.t ?? path[0], 'drag', input);
      await t.page.dragPath(f?.t, path, modifiers);
      t.refs.clear();
      return { ok: true, strategy: 'path', note: 'refs cleared: snapshot again' };
    }
    const to = input.to === undefined ? undefined : this.target(t, spec(input.to), frame);
    if (!f || !to) return fail('drag needs from and to (ref or {x,y}), or path');
    if ('error' in to) return fail(`to: ${to.error}`);
    if (input.approved !== true) {
      const toName = await this.nameAt(t, to);
      if (isDangerous(toName)) return this.needsApproval(toName);
    }
    await this.flower(t, f.t, 'drag', input);
    const out = await t.page.drag(f.t, to.t, modifiers);
    t.refs.clear(); // layout likely changed
    return { ok: true, strategy: out.strategy, note: 'refs cleared: snapshot again' };
  }

  private async mouse(t: Tab, input: Input): Promise<BrowserResult> {
    const action = str(input.action);
    const x = num(input.x);
    const y = num(input.y);
    const inRange = (v: number | undefined) => v !== undefined && v >= 0 && v <= MAX_COORD;
    if (action === 'move') {
      if (!inRange(x) || !inRange(y)) return fail('mouse move needs x and y (0-20000)');
      await this.flower(t, { x: x as number, y: y as number }, 'move', input);
      await t.page.mouse({
        action,
        x,
        y,
        steps: Math.min(50, Math.max(1, Math.round(num(input.steps) ?? 1))),
      });
      t.mouse = { x: x as number, y: y as number };
      return { ok: true };
    }
    if (action === 'down' || action === 'up') {
      if (action === 'down') {
        const name = (await t.page.describeAt(t.mouse.x, t.mouse.y))?.name ?? '';
        if (isDangerous(name) && input.approved !== true) return this.needsApproval(name);
      }
      await this.flower(t, t.mouse, 'drag', input);
      await t.page.mouse({ action });
      return { ok: true };
    }
    if (action === 'wheel') {
      const clamp = (v: number | undefined) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, v ?? 0));
      await this.flower(t, t.mouse, 'move', input);
      await t.page.mouse({ action, dx: clamp(num(input.dx)), dy: clamp(num(input.dy)) });
      return { ok: true };
    }
    return fail('mouse needs action: down|move|up|wheel');
  }

  private async typeOrFill(t: Tab, op: 'type' | 'fill', input: Input): Promise<BrowserResult> {
    const r = this.refInfo(t, input);
    if ('error' in r) return fail(`${op} ${r.error}`);
    const text = str(input.text);
    if (!text) return fail(`${op} needs text`);
    if (isSecureField(r.info)) {
      return fail(
        'Refusing to type into a password/card/secret field. The user signs in themselves through the profile sign-in flow.'
      );
    }
    if (
      input.submit === true &&
      op === 'type' &&
      isDangerous(r.info.name) &&
      input.approved !== true
    ) {
      return this.needsApproval(r.info.name);
    }
    const target = { ref: r.ref, frame: r.frame || undefined };
    await this.flower(t, target, 'move', input);
    if (op === 'fill') await t.page.fill(target, text);
    else await t.page.type(target, text.slice(0, 5000), input.submit === true);
    return { ok: true };
  }

  private async fieldOp(
    t: Tab,
    op: 'clear' | 'check' | 'uncheck',
    input: Input
  ): Promise<BrowserResult> {
    const r = this.refInfo(t, input);
    if ('error' in r) return fail(`${op} ${r.error}`);
    const target = { ref: r.ref, frame: r.frame || undefined };
    await this.flower(t, target, op === 'clear' ? 'move' : 'click', input);
    if (op === 'clear') {
      await t.page.clear(target);
      return { ok: true };
    }
    if (!CHECKABLE.has(r.info.role)) {
      return fail(`${r.ref} is a ${r.info.role}, not a checkbox, radio or switch`);
    }
    const res = await t.page.setChecked(target, op === 'check');
    return res === 'already'
      ? { ok: true, changed: false, note: `already ${op === 'check' ? 'checked' : 'unchecked'}` }
      : { ok: true, changed: true };
  }

  private async press(t: Tab, input: Input, signal?: AbortSignal): Promise<BrowserResult> {
    const hold = parseHold(input);
    if (hold) return 'error' in hold ? fail(hold.error) : this.hold(t, hold, input, signal);
    const key = str(input.key);
    if (!key) return fail('press needs key, e.g. "Enter" or "Control+a"');
    const focused = await t.page.describeFocused();
    if (focused) {
      if (
        isSecureField(focused) &&
        !/^(Tab|Escape|Shift\+Tab)$/i.test(key) &&
        (key.length === 1 || /^(Control|Meta)\+v$/i.test(key))
      ) {
        return fail('Refusing to type into a password/card/secret field.');
      }
      if (/^Enter$/i.test(key) && isDangerous(focused.name) && input.approved !== true) {
        return this.needsApproval(focused.name);
      }
    }
    await t.page.press(key);
    return { ok: true, ...this.dialogHint(t) };
  }

  /**
   * Holds keys down together. Stricter than a tap: no hold at all in a secret
   * field, and holding Enter or Space (both activate a focused control) on a
   * consequential one needs approval.
   */
  private async hold(
    t: Tab,
    h: { keys: string[]; ms: number },
    input: Input,
    signal?: AbortSignal
  ): Promise<BrowserResult> {
    if (t.page.pendingDialog()) {
      return fail('A dialog is open; handle it with op:dialog before holding keys.');
    }
    const focused = await t.page.describeFocused();
    if (focused && isSecureField(focused)) {
      return fail('Refusing to hold keys in a password/card/secret field.');
    }
    if (
      focused &&
      h.keys.some((k) => ACTIVATION_KEYS.has(k)) &&
      isDangerous(focused.name) &&
      input.approved !== true
    ) {
      return this.needsApproval(focused.name);
    }
    const r = await t.page.holdKeys(h.keys, h.ms, signal);
    if (r.end === 'aborted') {
      return {
        ok: false,
        cancelled: true,
        message: 'The run was stopped; the keys were released.',
      };
    }
    if (r.end === 'closed') return fail('The tab closed while the keys were held.');
    if (r.end === 'dialog') {
      return fail(
        'A dialog opened while the keys were held; they were released. Handle it with op:dialog.',
        this.dialogHint(t)
      );
    }
    return { ok: true, held: h.keys, ms: r.heldMs, ...this.dialogHint(t) };
  }

  private async select(t: Tab, input: Input): Promise<BrowserResult> {
    const r = this.refInfo(t, input);
    if ('error' in r) return fail(`select ${r.error}`);
    const option = str(input.option);
    if (!option) return fail('select needs option');
    const label = `${r.info.name} ${option}`;
    if (isDangerous(label) && input.approved !== true) return this.needsApproval(label.trim());
    await this.flower(t, { ref: r.ref, frame: r.frame || undefined }, 'click', input);
    await t.page.select({ ref: r.ref, frame: r.frame || undefined }, option);
    return { ok: true };
  }

  private async upload(t: Tab, agent: AgentInfo, input: Input): Promise<BrowserResult> {
    const r = this.refInfo(t, input);
    if ('error' in r) return fail(`upload ${r.error}`);
    const files = Array.isArray(input.files) ? input.files.map(String) : [];
    if (!files.length) return fail('upload needs files: paths inside your project folder');
    const checked: string[] = [];
    for (const f of files) {
      const p = await this.allowedUploadPath(agent, f);
      if ('error' in p) return fail(p.error);
      checked.push(p.path);
    }
    await this.flower(t, { ref: r.ref, frame: r.frame || undefined }, 'move', input);
    await t.page.upload({ ref: r.ref, frame: r.frame || undefined }, checked);
    return { ok: true, files: checked.length };
  }

  private async allowedUploadPath(
    agent: AgentInfo,
    file: string
  ): Promise<{ path: string } | { error: string }> {
    if (!agent.cwd) return { error: 'No project folder is available for uploads.' };
    const abs = path.resolve(agent.cwd, file);
    let real: string;
    let base: string;
    try {
      real = await realpath(abs);
      base = await realpath(agent.cwd);
    } catch {
      return { error: `file not found: ${file}` };
    }
    const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
    if (!inside(base, real))
      return {
        error: `${file} is outside your project folder; uploads may only use files inside it.`,
      };
    const home = this.deps.home();
    let homeReal = home;
    try {
      homeReal = await realpath(home);
    } catch {
      /* home may not exist in tests */
    }
    if (inside(homeReal, real) && !inside(path.join(homeReal, 'projects'), real)) {
      return { error: `${file} is inside Snaglet's private data and cannot be uploaded.` };
    }
    const st = await stat(real);
    if (!st.isFile()) return { error: `${file} is not a file` };
    return { path: real };
  }

  private async saveDownload(
    agent: AgentInfo,
    d: { suggestedFilename: string; saveAs: (p: string) => Promise<void> }
  ) {
    try {
      const dir = agent.cwd ?? path.join(this.deps.home(), 'downloads');
      await mkdir(dir, { recursive: true });
      const safe = path.basename(d.suggestedFilename).replace(/[^\w.\- ]/g, '_') || 'download';
      const candidate = await uniquePath(dir, safe);
      await d.saveAs(candidate);
      const list = this.downloads.get(agent.id) ?? [];
      list.push({ file: candidate, name: safe });
      this.downloads.set(agent.id, list.slice(-20));
    } catch (err) {
      this.deps.log({ op: 'download-failed', agentId: agent.id, error: getErrorMessage(err) });
    }
  }
}
