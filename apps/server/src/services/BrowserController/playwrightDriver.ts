import { writeFile } from 'node:fs/promises';
import { OwedKeyups, pressAndHold } from './keyHold';
import { PROBE_SRC } from './probe';
import type {
  BrowserDriver,
  DriverContext,
  DriverPage,
  ConsoleEntry,
  ElementInfo,
  NetworkEntry,
  Engine,
  FrameInfo,
  Modifier,
  RefT,
  LaunchOptions,
  PageAvatar,
  Target,
} from './types';

// Loaded lazily so importing the server never loads Playwright until used.
type PW = typeof import('playwright-core');
type PwPage = import('playwright-core').Page;
type PwContext = import('playwright-core').BrowserContext;

/** Best-effort cleanup where a failure changes nothing for the caller. */
const quiet = (): undefined => undefined;

const ACTION_TIMEOUT = 10_000;
const STEPS = 12;

const sel = (ref: string) => `[data-snaglet-ref="${ref.replace(/[^a-z0-9]/gi, '')}"]`;

class PlaywrightPage implements DriverPage {
  private dialog: import('playwright-core').Dialog | null = null;
  /** Releases a dialog swallowed. */
  private readonly owed: OwedKeyups;
  constructor(private readonly page: PwPage) {
    page.on('dialog', (d) => {
      this.dialog = d;
    });
    // A dialog blocks only the process of the frame that opened it (a cross-site
    // iframe has its own), and Playwright's Dialog does not say which frame
    // that is: wait until every frame runs script again.
    this.owed = new OwedKeyups(page.keyboard, () =>
      Promise.allSettled(page.frames().map((f) => f.evaluate('0')))
    );
  }
  url = () => this.page.url();
  title = () => this.page.title();
  async goto(url: string) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  async nav(kind: 'back' | 'forward' | 'reload') {
    const o = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };
    if (kind === 'back') await this.page.goBack(o);
    else if (kind === 'forward') await this.page.goForward(o);
    else await this.page.reload(o);
  }
  close = () => this.page.close();
  isClosed = () => this.page.isClosed();
  bringToFront = () => this.page.bringToFront();

  /** Resolve a frame by index, name or url substring. */
  private fr(f?: string): import('playwright-core').Frame {
    if (f === undefined || f === '') return this.page.mainFrame();
    const frames = this.page.frames();
    const hit = /^\d+$/.test(f)
      ? frames[Number(f)]
      : (frames.find((x) => x.name() === f) ?? frames.find((x) => x.url().includes(f)));
    if (!hit) throw new Error(`unknown frame "${f}": see frames in op:snapshot`);
    return hit;
  }
  frames(): FrameInfo[] {
    return this.page
      .frames()
      .map((f, index) => ({ index, name: f.name(), url: f.url().slice(0, 120) }));
  }
  private probe<T>(mode: string, arg: unknown, frame?: string): Promise<T> {
    return this.fr(frame).evaluate(
      `${PROBE_SRC}(${JSON.stringify(mode)}, ${JSON.stringify(arg ?? null)})`
    ) as Promise<T>;
  }
  collect = (max: number, frame?: string) =>
    this.probe<{ elements: ElementInfo[]; truncated: boolean }>('collect', max, frame);
  async read(o: { ref?: string; frame?: string; max: number }) {
    const r = await this.probe<{ markdown: string; truncated: boolean; missing?: boolean }>(
      'read',
      { ref: o.ref ? o.ref.replace(/[^a-z0-9]/gi, '') : '', max: o.max },
      o.frame
    );
    if (r.missing) throw new Error(`stale ref ${o.ref}: snapshot again`);
    return r;
  }
  describeAt = (x: number, y: number) => this.probe<ElementInfo | null>('at', { x, y });
  describeFocused = () => this.probe<ElementInfo | null>('focused', null);

  private loc(t: RefT) {
    return this.fr(t.frame).locator(sel(t.ref)).first();
  }
  private async live(t: RefT) {
    const l = this.loc(t);
    if ((await l.count()) === 0) throw new Error(`stale ref ${t.ref}: snapshot again`);
    return l;
  }
  private async point(t: Target): Promise<{ x: number; y: number }> {
    if ('x' in t) return { x: t.x, y: t.y };
    const l = await this.live(t);
    await l.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(quiet);
    const b = await l.boundingBox();
    if (!b) throw new Error(`ref ${t.ref} has no box`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  private async withMods<T>(mods: Modifier[], fn: () => Promise<T>): Promise<T> {
    for (const m of mods) await this.page.keyboard.down(m);
    try {
      return await fn();
    } finally {
      for (const m of [...mods].reverse()) await this.page.keyboard.up(m).catch(quiet);
    }
  }
  async click(
    t: Target,
    o: { button: 'left' | 'right' | 'middle'; double: boolean; modifiers: Modifier[] }
  ) {
    const p = await this.point(t);
    await this.page.mouse.move(p.x, p.y, { steps: 4 });
    await this.withMods(o.modifiers, async () => {
      if (o.double) await this.page.mouse.dblclick(p.x, p.y, { button: o.button });
      else await this.page.mouse.click(p.x, p.y, { button: o.button });
    });
  }
  async hover(t: Target, modifiers: Modifier[]) {
    const p = await this.point(t);
    await this.withMods(modifiers, () => this.page.mouse.move(p.x, p.y, { steps: 4 }));
  }
  private async manualDrag(
    a: { x: number; y: number },
    via: Array<{ x: number; y: number }>,
    mods: Modifier[]
  ) {
    const m = this.page.mouse;
    await this.withMods(mods, async () => {
      await m.move(a.x, a.y, { steps: 3 });
      await m.down();
      // A small nudge first starts HTML5 drags and sortable libraries.
      await m.move(a.x + 4, a.y + 4, { steps: 2 });
      let cur = { x: a.x + 4, y: a.y + 4 };
      for (const b of via) {
        await this.glide(b, 'drag');
        for (let i = 1; i <= STEPS; i += 1) {
          await m.move(cur.x + ((b.x - cur.x) * i) / STEPS, cur.y + ((b.y - cur.y) * i) / STEPS);
        }
        cur = b;
      }
      await m.up();
    });
  }
  async drag(from: Target, to: Target, modifiers: Modifier[]) {
    if ('ref' in from && 'ref' in to && modifiers.length === 0 && !from.frame && !to.frame) {
      const before = await this.probe<string>('signature', from.ref);
      try {
        await this.loc(from).dragTo(this.loc(to), { timeout: 4000 });
        const after = await this.probe<string>('signature', from.ref);
        if (after !== before) return { strategy: 'dragTo' };
      } catch {
        // fall through to real stepped mouse input
      }
    }
    await this.manualDrag(await this.point(from), [await this.point(to)], modifiers);
    return { strategy: 'mouse-steps' };
  }
  async dragPath(
    start: Target | undefined,
    path: Array<{ x: number; y: number }>,
    modifiers: Modifier[]
  ) {
    const first = start ? await this.point(start) : path[0];
    await this.manualDrag(first, start ? path : path.slice(1), modifiers);
  }
  async mouse(a: {
    action: 'down' | 'move' | 'up' | 'wheel';
    x?: number;
    y?: number;
    dx?: number;
    dy?: number;
    steps?: number;
  }) {
    const m = this.page.mouse;
    if (a.action === 'move') await m.move(a.x ?? 0, a.y ?? 0, { steps: a.steps ?? 1 });
    else if (a.action === 'down') await m.down();
    else if (a.action === 'up') await m.up();
    else await m.wheel(a.dx ?? 0, a.dy ?? 0);
  }
  async type(t: RefT, text: string, submit: boolean) {
    const l = await this.live(t);
    await l.click({ timeout: 3000 }).catch(quiet);
    await l.pressSequentially(text, { delay: 10, timeout: ACTION_TIMEOUT });
    if (submit) await this.page.keyboard.press('Enter');
  }
  async fill(t: RefT, text: string) {
    const l = await this.live(t);
    await l.click({ timeout: 3000 }).catch(quiet);
    await l.fill(text, { timeout: ACTION_TIMEOUT });
  }
  async clear(t: RefT) {
    await (await this.live(t)).clear({ timeout: ACTION_TIMEOUT });
  }
  async setChecked(t: RefT, want: boolean) {
    const l = await this.live(t);
    if ((await l.isChecked({ timeout: 3000 })) === want) return 'already' as const;
    await l.setChecked(want, { timeout: ACTION_TIMEOUT });
    return 'changed' as const;
  }
  press = (key: string) => this.page.keyboard.press(key);
  async holdKeys(keys: string[], ms: number, signal?: AbortSignal) {
    const { pressed, ...out } = await pressAndHold(this.page.keyboard, keys, ms, {
      signal,
      onInterrupt: (cb) => {
        const closed = () => cb('closed');
        const dialog = () => cb('dialog');
        this.page.on('close', closed).on('crash', closed).on('dialog', dialog);
        return () => {
          this.page.off('close', closed).off('crash', closed).off('dialog', dialog);
        };
      },
    });
    if (this.dialog) this.owed.add(pressed);
    return out;
  }
  async select(t: RefT, option: string) {
    const l = await this.live(t);
    try {
      await l.selectOption({ label: option }, { timeout: 3000 });
    } catch {
      await l.selectOption({ value: option }, { timeout: ACTION_TIMEOUT });
    }
  }
  async upload(t: RefT, files: string[]) {
    await (await this.live(t)).setInputFiles(files, { timeout: ACTION_TIMEOUT });
  }
  async scroll(t: Target | undefined, dx: number, dy: number) {
    if (t) {
      const p = await this.point(t);
      await this.page.mouse.move(p.x, p.y);
    }
    await this.page.mouse.wheel(dx, dy);
  }
  async wait(o: { selector?: string; text?: string; ms?: number }) {
    if (o.selector)
      await this.page.waitForSelector(o.selector, { state: 'visible', timeout: 15_000 });
    else if (o.text)
      await this.page.getByText(o.text).first().waitFor({ state: 'visible', timeout: 15_000 });
    else await this.page.waitForTimeout(o.ms ?? 1000);
  }
  async screenshot(ref?: RefT) {
    if (ref) return (await this.live(ref)).screenshot({ timeout: ACTION_TIMEOUT });
    return this.page.screenshot({ timeout: ACTION_TIMEOUT });
  }
  async pdf(destPath: string) {
    // CDP printToPDF also works in headed Chrome (page.pdf() is headless-only).
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      const { data } = await cdp.send('Page.printToPDF', { printBackground: true });
      await writeFile(destPath, Buffer.from(data, 'base64'), { flag: 'wx' });
    } finally {
      await cdp.detach().catch(quiet);
    }
  }
  async resize(width: number, height: number, scale?: number) {
    await this.page.setViewportSize({ width, height });
    if (scale) {
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
    }
  }
  pendingDialog() {
    return this.dialog
      ? { type: this.dialog.type(), message: this.dialog.message().slice(0, 200) }
      : null;
  }
  async handleDialog(accept: boolean) {
    const d = this.dialog;
    if (!d) throw new Error('no dialog is open');
    this.dialog = null;
    await this.owed.afterHandling(() => (accept ? d.accept() : d.dismiss()));
  }
  private flowerLabel: string | undefined;
  private flowerTheme: unknown;
  private flowerAvatar: PageAvatar | undefined;
  private lastFlower: { x: number; y: number } | null = null;
  private async glide(p: { x: number; y: number } | null, state: string) {
    if (p) this.lastFlower = p;
    else if (state === 'error' && this.lastFlower) p = this.lastFlower;
    const x = p ? String(p.x) : 'window.innerWidth / 2';
    const y = p ? String(p.y) : 'window.innerHeight / 2';
    await this.page
      .evaluate(
        `(function(){var i=window.__snagletAgentCursor;if(i){var th=${JSON.stringify(this.flowerTheme ?? null)},av=${JSON.stringify(this.flowerAvatar ?? null)};if(th)i.theme=th;if(av){i.avatar=av.avatar;i.avatarStumped=av.avatarStumped;i.avatars=av.avatars;i.ringColor=av.ringColor}}})();window.__snagletAgentCursorMove && window.__snagletAgentCursorMove(${x}, ${y}, ${JSON.stringify(state)}, ${JSON.stringify(this.flowerLabel ?? '')})`
      )
      .catch(quiet);
  }
  async flower(
    t: Target | undefined,
    state: 'move' | 'click' | 'drag' | 'error',
    label?: string,
    theme?: { background: string; text: string; border: string },
    avatar?: PageAvatar
  ) {
    this.flowerLabel = label;
    this.flowerTheme = theme;
    this.flowerAvatar = avatar;
    try {
      let p: { x: number; y: number } | null = null;
      if (t && 'x' in t) p = { x: t.x, y: t.y };
      else if (t) {
        const l = this.loc(t);
        if ((await l.count()) > 0) {
          await l.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(quiet);
          const b = await l.boundingBox();
          if (b) p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
      }
      if (p || !t) await this.glide(p, state);
    } catch {
      // the flower is decoration; never block the action
    }
  }
  async setEmotion(emotion: string, ttlMs: number) {
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, Math.min(ttlMs, 60_000)) : 0;
    await this.page
      .evaluate(
        `window.__snagletAgentCursorEmotion && window.__snagletAgentCursorEmotion(${JSON.stringify(String(emotion))}, ${ttl})`
      )
      .catch(quiet);
  }
  async installCursor(script: string) {
    await this.page.addInitScript(script);
    await this.page.evaluate(script).catch(quiet);
  }
  onConsole(cb: (e: ConsoleEntry) => void) {
    this.page.on('console', (m) => {
      const t = m.type();
      cb({
        level: t === 'error' ? 'error' : t === 'warning' ? 'warn' : 'log',
        text: m.text(),
      });
    });
    this.page.on('pageerror', (e) => cb({ level: 'error', text: String(e.message) }));
  }
  onNetwork(cb: (e: NetworkEntry) => void) {
    this.page.on('response', (r) => {
      if (r.status() >= 400) {
        cb({ method: r.request().method(), url: r.url(), status: r.status() });
      }
    });
    this.page.on('requestfailed', (r) =>
      cb({ method: r.method(), url: r.url(), status: 0, failure: r.failure()?.errorText })
    );
  }
  onDownload(cb: Parameters<DriverPage['onDownload']>[0]) {
    this.page.on('download', (d) =>
      cb({ suggestedFilename: d.suggestedFilename(), saveAs: (p) => d.saveAs(p) })
    );
  }
  onNavigated(cb: (url: string) => void) {
    this.page.on('framenavigated', (f) => {
      if (f === this.page.mainFrame()) cb(f.url());
    });
  }
  onClosed(cb: () => void) {
    this.page.on('close', cb);
  }
}

class PlaywrightContext implements DriverContext {
  private adopted = false;
  constructor(
    private readonly ctx: PwContext,
    private readonly closeAll: () => Promise<void>,
    private readonly forUser: boolean,
    readonly note?: string
  ) {}
  async newPage() {
    let page: PwPage | undefined;
    if (!this.adopted && !this.forUser) {
      page = this.ctx.pages().find((p) => p.url() === 'about:blank');
    }
    this.adopted = true;
    page ??= await this.ctx.newPage();
    return new PlaywrightPage(page);
  }
  async ensureWindow() {
    if (this.ctx.pages().length === 0) await this.ctx.newPage();
  }
  async traceStart() {
    await this.ctx.tracing.start({ screenshots: true, snapshots: true });
  }
  async traceStop(destPath: string) {
    await this.ctx.tracing.stop({ path: destPath });
  }
  close = () => this.closeAll();
  onClosed(cb: () => void) {
    this.ctx.on('close', cb);
  }
}

const CHROME_ARGS = { ignoreDefaultArgs: ['--enable-automation'] };
const missingBrowser = (e: unknown) =>
  /Executable doesn't exist|executable doesn't exist|Chromium distribution|not found|ENOENT/i.test(
    String((e as Error)?.message ?? e)
  );

export class PlaywrightDriver implements BrowserDriver {
  /** headless is for tests; Snaglet always shows the browser to the user. */
  constructor(private readonly opts: { headless?: boolean } = {}) {}

  async launch(o: LaunchOptions): Promise<DriverContext> {
    const pw: PW = await import('playwright-core');
    const engine: Engine = o.engine;
    const headless = this.opts.headless === true;
    // Headed Chrome gives each site its own process; the headless shell does
    // not unless asked, and frame behavior (dialogs, script) depends on it.
    const isolation = headless ? { args: ['--site-per-process'] } : {};
    if (engine === 'webkit') {
      if (o.profileDir) throw new Error('webkit is only available for the temp profile');
      const browser = await pw.webkit.launch({ headless });
      const ctx = await browser.newContext({ viewport: null });
      return new PlaywrightContext(ctx, () => browser.close(), o.forUser);
    }
    let note: string | undefined;
    const attempt = async (channel?: 'chrome') => {
      if (o.profileDir) {
        const ctx = await pw.chromium.launchPersistentContext(o.profileDir, {
          ...CHROME_ARGS,
          headless,
          ...isolation,
          ...(channel ? { channel } : {}),
          viewport: null,
        });
        return { ctx, close: () => ctx.close() };
      }
      const browser = await pw.chromium.launch({
        ...CHROME_ARGS,
        headless,
        ...isolation,
        ...(channel ? { channel } : {}),
      });
      const ctx = await browser.newContext({ viewport: null });
      return { ctx, close: () => browser.close() };
    };
    let launched: { ctx: PwContext; close: () => Promise<void> };
    if (engine === 'chrome') {
      try {
        launched = await attempt('chrome');
      } catch (e) {
        if (!missingBrowser(e)) throw e;
        note = 'Google Chrome was not found; using the bundled Chromium instead.';
        launched = await attempt();
      }
    } else {
      launched = await attempt();
    }
    return new PlaywrightContext(launched.ctx, launched.close, o.forUser, note);
  }
}
