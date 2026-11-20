/**
 * Held keys through the real Playwright driver and Chromium (headless), on a
 * local test page that records every key event and, like a drawing app, moves
 * a pen once per animation frame while keys are held. Self-skips only when
 * Playwright reports its Chromium is not installed
 * (`pnpm exec playwright install chromium`); any other launch failure fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserController } from '@server/services/BrowserController/BrowserController';
import { OwedKeyups, pressAndHold } from '@server/services/BrowserController/keyHold';
import { PlaywrightDriver } from '@server/services/BrowserController/playwrightDriver';

type Ev = [t: number, type: 'd' | 'u', key: string, code: string, repeat: 0 | 1];
interface PageLog {
  ev: Ev[];
  frames: Record<string, { n: number; first: number; last: number }>;
  pen: { x: number; y: number };
}

const PAGE = `<!doctype html><title>keys</title><body><p id="log"></p><script>
var ev = [], held = {}, frames = {}, pen = { x: 0, y: 0 };
var alertOn = window.ALERT_ON || new URLSearchParams(location.search).get('alert');
function show() {
  document.getElementById('log').textContent =
    'LOG' + JSON.stringify({ ev: ev, frames: frames, pen: pen }) + 'END';
}
addEventListener('keydown', function (e) {
  ev.push([Date.now(), 'd', e.key, e.code, e.repeat ? 1 : 0]);
  held[e.key] = 1;
  show();
  if (alertOn && e.key === alertOn) alert('held ' + e.key);
});
addEventListener('keyup', function (e) {
  ev.push([Date.now(), 'u', e.key, e.code, e.repeat ? 1 : 0]);
  delete held[e.key];
  show();
});
function tick() {
  var ks = Object.keys(held).sort().join('+');
  if (ks) {
    var f = frames[ks] || (frames[ks] = { n: 0, first: Date.now(), last: 0 });
    f.n += 1;
    f.last = Date.now();
    if (held.d) pen.x += 1;
    if (held.a) pen.x -= 1;
    if (held.s) pen.y += 1;
    if (held.w) pen.y -= 1;
    show();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
show();
</script>`;

/**
 * Launches headless Chromium through Playwright's public API in a child
 * process (jest decides what to skip synchronously). Exit 2 = Playwright says
 * the browser is not installed; anything else runs the suite.
 */
function chromiumMissing(): boolean {
  const probe = `require(${JSON.stringify(require.resolve('playwright-core'))})
    .chromium.launch({ headless: true })
    .then((b) => b.close())
    .then(() => process.exit(0), (e) => process.exit(/Executable doesn't exist/i.test(String(e && e.message)) ? 2 : 1));`;
  return (
    spawnSync(process.execPath, ['-e', probe], { stdio: 'ignore', timeout: 60_000 }).status === 2
  );
}
const missing = chromiumMissing();
const describeChromium = missing ? describe.skip : describe;
const SKIP_NOTE = missing ? ' (skipped: run pnpm exec playwright install chromium)' : '';

/** Chromium processes this test process launched (for the disconnect case). */
function ownBrowserPids(): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === process.pid && /chrom/i.test(comm ?? ''))
    .map(([pid]) => Number(pid));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeChromium(`held keys in real Chromium${SKIP_NOTE}`, () => {
  jest.setTimeout(30_000);
  const A = { id: 'test-agent-a', name: 'Test A', flower: 'daisy', color: '#fff' };
  let server: http.Server;
  let base: string;
  let home: string;
  let c: BrowserController;
  let approvals = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      // /game: the test page inside a cross-site iframe (localhost vs 127.0.0.1).
      if (req.url?.startsWith('/game')) {
        const port = (server.address() as AddressInfo).port;
        res.end(
          `<!doctype html><body><iframe src="http://localhost:${port}/?alert=d" style="position:fixed;left:0;top:0;width:600px;height:400px;border:0"></iframe>`
        );
      } else {
        res.end(PAGE);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    home = await mkdtemp(path.join(os.tmpdir(), 'snaglet-browser-keys-'));
    c = new BrowserController({
      driver: new PlaywrightDriver({ headless: true }),
      home: () => home,
      now: Date.now,
      env: () => ({ SNAGLET_BROWSER_ENGINE: 'chromium', SNAGLET_BROWSER_CURSOR: '0' }),
      log: () => undefined,
      startSweeper: () => undefined,
      approval: {
        required: () => true,
        hasGrant: () => false,
        request: async () => {
          approvals += 1;
          return 'deny';
        },
        handoff: async () => 'deny',
      },
    });
  });

  afterAll(async () => {
    await c?.shutdown();
    await new Promise((r) => server?.close(r));
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A fresh tab on the test page in the isolated temp profile. */
  async function openPage(query = ''): Promise<void> {
    const r = await c.run(A, { op: 'open', profile: 'temp', url: `${base}${query}` });
    expect(r).toMatchObject({ ok: true, profile: 'temp' });
  }
  async function pageLog(frame?: string): Promise<PageLog> {
    const r = await c.run(A, { op: 'read', ...(frame ? { frame } : {}) });
    const m = /LOG(.*)END/.exec(String(r.text));
    if (!m) throw new Error(`no log on the page: ${JSON.stringify(r).slice(0, 300)}`);
    return JSON.parse(m[1]) as PageLog;
  }
  const evs = (log: PageLog, type: 'd' | 'u', key: string) =>
    log.ev.filter((e) => e[1] === type && e[2] === key);

  afterEach(async () => {
    await c.run(A, { op: 'close' });
  });

  it('a tap of D draws nothing; holding D for 500 ms keeps it down across frames', async () => {
    await openPage();
    expect(await c.run(A, { op: 'press', key: 'd' })).toEqual({ ok: true });
    await delay(100);
    const tap = await pageLog();
    expect(tap.pen.x).toBeLessThanOrEqual(1);

    const r = await c.run(A, { op: 'press', key: 'd', hold_ms: 500 });
    expect(r).toMatchObject({ ok: true, held: ['d'] });
    expect(r.ms as number).toBeGreaterThanOrEqual(495);
    expect(r.ms as number).toBeLessThan(1500);

    const log = await pageLog();
    const [, down] = evs(log, 'd', 'd');
    const [, up] = evs(log, 'u', 'd');
    expect(evs(log, 'd', 'd')).toHaveLength(2); // the tap, then the hold
    expect(down[4]).toBe(0); // no synthetic auto-repeat
    expect(down[3]).toBe('KeyD');
    expect(up[0] - down[0]).toBeGreaterThanOrEqual(495);
    expect(up[0] - down[0]).toBeLessThan(1500);
    // The animation loop saw D held for (nearly) the whole hold.
    const f = log.frames.d;
    expect(f.last - f.first).toBeGreaterThanOrEqual(400);
    expect(f.n).toBeGreaterThanOrEqual(10);
    expect(log.pen.x).toBeGreaterThan(tap.pen.x + 10);
  });

  it('W + D are both down before either comes up (diagonal), released in reverse', async () => {
    await openPage();
    const r = await c.run(A, { op: 'press', keys: ['w', 'd'], hold_ms: 400 });
    expect(r).toMatchObject({ ok: true, held: ['w', 'd'] });
    const log = await pageLog();
    expect(log.ev.map((e) => `${e[1]} ${e[2]}`)).toEqual(['d w', 'd d', 'u d', 'u w']);
    expect(log.ev.every((e) => e[4] === 0)).toBe(true);
    expect(log.frames['d+w'].n).toBeGreaterThanOrEqual(8);
    expect(log.pen.x).toBeGreaterThan(5);
    expect(log.pen.y).toBeLessThan(-5);
  });

  it('batch: holds run one after another (right, then down)', async () => {
    await openPage();
    const r = await c.run(A, {
      op: 'batch',
      steps: [
        { op: 'press', key: 'd', hold_ms: 250 },
        { op: 'press', key: 's', hold_ms: 250 },
      ],
    });
    expect(r).toMatchObject({ ok: true });
    const log = await pageLog();
    expect(log.ev.map((e) => `${e[1]} ${e[2]}`)).toEqual(['d d', 'u d', 'd s', 'u s']);
    expect(log.pen.x).toBeGreaterThan(5);
    expect(log.pen.y).toBeGreaterThan(5);
  });

  it('a stopped run releases both keys promptly', async () => {
    await openPage();
    const ac = new AbortController();
    const held = c.run(A, { op: 'press', keys: ['w', 'd'], hold_ms: 4000 }, { signal: ac.signal });
    await delay(300);
    const stoppedAt = Date.now();
    ac.abort();
    const r = await held;
    expect(Date.now() - stoppedAt).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: false, cancelled: true });
    const log = await pageLog();
    const ups = log.ev.filter((e) => e[1] === 'u');
    expect(ups.map((e) => e[2])).toEqual(['d', 'w']);
    for (const u of ups) expect(u[0] - stoppedAt).toBeLessThan(800);
  });

  it('the kill switch closing the tab mid-hold ends the hold without throwing', async () => {
    await openPage();
    const held = c.run(A, { op: 'press', keys: ['w', 'd'], hold_ms: 4000 });
    await delay(300);
    const closedAt = Date.now();
    expect(await c.stopAll()).toBe(1);
    const r = await held;
    expect(Date.now() - closedAt).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/closed while the keys/) });
    // The browser is still usable: a new tab gets clean key events.
    await openPage();
    await c.run(A, { op: 'press', key: 'w', hold_ms: 50 });
    const log = await pageLog();
    expect(log.ev.map((e) => `${e[1]} ${e[2]} ${e[4]}`)).toEqual(['d w 0', 'u w 0']);
  });

  it('a dialog opened by a held key ends the hold; op:dialog delivers each release once', async () => {
    await openPage('?alert=d');
    const startedAt = Date.now();
    const r = await c.run(A, { op: 'press', keys: ['w', 'd', 's'], hold_ms: 3000 });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(r).toMatchObject({ ok: false, dialog: { type: 'alert', message: 'held d' } });
    expect(await c.run(A, { op: 'dialog', action: 'dismiss' })).toMatchObject({ ok: true });
    await delay(200);
    const log = await pageLog();
    // s never went down, so it gets no release either.
    expect(log.ev.map((e) => `${e[1]} ${e[2]}`)).toEqual(['d w', 'd d', 'u d', 'u w']);
  });

  it('a dialog in a cross-site iframe: the release waits for that frame, not the page', async () => {
    // Headless runs isolate sites like headed Chrome, so the iframe has its own
    // process and its alert does not block the top page's scripts.
    await openPage('game');
    for (let i = 0; i < 50; i += 1) {
      const r = await c.run(A, { op: 'read', frame: 'localhost' });
      if (r.ok === true && /LOG/.test(String(r.text))) break;
      await delay(100);
    }
    expect(await c.run(A, { op: 'click', x: 100, y: 100 })).toMatchObject({ ok: true });
    const r = await c.run(A, { op: 'press', key: 'd', hold_ms: 3000 });
    expect(r).toMatchObject({ ok: false, dialog: { type: 'alert', message: 'held d' } });
    await delay(300);
    expect(await c.run(A, { op: 'dialog', action: 'dismiss' })).toMatchObject({ ok: true });
    await delay(200);
    const log = await pageLog('localhost');
    expect(log.ev.map((e) => `${e[1]} ${e[2]}`)).toEqual(['d d', 'u d']);
  });

  it('existing taps still work: "a", "Enter", "Control+a"', async () => {
    await openPage();
    for (const key of ['a', 'Enter', 'Control+a']) {
      expect(await c.run(A, { op: 'press', key })).toEqual({ ok: true });
    }
    const log = await pageLog();
    expect(log.ev.map((e) => `${e[1]} ${e[2]}`)).toEqual([
      'd a',
      'u a',
      'd Enter',
      'u Enter',
      'd Control',
      'd a',
      'u a',
      'u Control',
    ]);
    expect(Object.keys(log.frames).length).toBeLessThanOrEqual(3);
  });

  it('a browser that dies mid-hold ends the hold without throwing', async () => {
    await openPage();
    const held = c.run(A, { op: 'press', key: 'd', hold_ms: 4000 });
    await delay(300);
    const pids = ownBrowserPids();
    expect(pids.length).toBeGreaterThan(0);
    const killedAt = Date.now();
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    const r = await held;
    expect(Date.now() - killedAt).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/closed while the keys/) });
    // The next open launches a fresh browser.
    await openPage();
    expect(await c.run(A, { op: 'press', key: 'd', hold_ms: 20 })).toMatchObject({ ok: true });
  });

  it('the temp profile never asked for approval', () => {
    expect(approvals).toBe(0);
  });
});

describeChromium(`pressAndHold on a real page${SKIP_NOTE}`, () => {
  jest.setTimeout(30_000);
  const events = async (page: import('playwright-core').Page) =>
    (JSON.parse(/LOG(.*)END/.exec((await page.textContent('#log')) ?? '')![1]) as PageLog).ev.map(
      (e) => `${e[1]} ${e[2]}`
    );

  it('a dialog closed by hand releases the held keys; a later op:dialog adds none', async () => {
    const pw = await import('playwright-core');
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE.replace('<script>', "<script>var ALERT_ON = 'd';"));
      let dialog: import('playwright-core').Dialog | undefined;
      page.on('dialog', (d) => {
        dialog = d;
      });
      // The same pieces the driver's holdKeys and handleDialog use.
      const owed = new OwedKeyups(page.keyboard, () => page.evaluate('0'));
      const r = await pressAndHold(page.keyboard, ['w', 'd', 's'], 3000, {
        onInterrupt: (cb) => {
          const opened = () => cb('dialog');
          page.on('dialog', opened);
          return () => page.off('dialog', opened);
        },
      });
      expect(r).toMatchObject({ end: 'dialog', pressed: ['w', 'd'] });
      owed.add(r.pressed);
      await delay(200);
      // The person clicks OK in the window; nobody calls op:dialog.
      await dialog!.accept();
      await delay(200);
      expect(await events(page)).toEqual(['d w', 'd d', 'u d', 'u w']);
      // op:dialog afterward: dismissing a handled dialog throws, nothing is sent twice.
      await expect(owed.afterHandling(() => dialog!.dismiss())).rejects.toThrow(/already handled/);
      await delay(100);
      expect(await events(page)).toEqual(['d w', 'd d', 'u d', 'u w']);
    } finally {
      await browser.close();
    }
  });

  it('a key Playwright refuses mid-hold leaves nothing held', async () => {
    const pw = await import('playwright-core');
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      await expect(pressAndHold(page.keyboard, ['w', 'NotAKey'], 500)).rejects.toThrow(
        /Unknown key/
      );
      // A fresh press of W is a first press again (not a repeat): nothing was left down.
      await page.keyboard.press('w');
      const log = JSON.parse(
        /LOG(.*)END/.exec((await page.textContent('#log')) ?? '')![1]
      ) as PageLog;
      expect(log.ev.map((e) => `${e[1]} ${e[2]} ${e[4]}`)).toEqual([
        'd w 0',
        'u w 0',
        'd w 0',
        'u w 0',
      ]);
    } finally {
      await browser.close();
    }
  });
});
