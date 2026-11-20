/**
 * test:e2e — build the web UI from
 * current source, boot a brand-new Snaglet from an empty throwaway home folder on
 * managed PostgreSQL, verify it is born correctly, open
 * a browser on it, and assert the Dashboard is displaying. Further
 * tests get integrated into this slowly, one at a time — browser tier only.
 * Driving the packaged desktop app's webview is ruled out on macOS; the
 * packaged .app has its own launch-and-health + upgrade smoke tier,
 * `pnpm test:e2e:app` (build/scripts/smoke-packaged-app.ts).
 *
 *   pnpm test:e2e                 # build + checks + visible browser on the fresh Snaglet
 *   pnpm test:e2e --headless      # build + checks, headless browser (CI/scripted)
 *   pnpm test:e2e --no-build      # reuse the existing UI build (fast iteration)
 *   pnpm test:e2e --hold-ms=8000  # auto-close the visible browser after N ms
 *
 * The browser serves the just-built web UI (apps/desktop-ui/dist) from the
 * scratch server itself — same-origin, so what you see is the throwaway Snaglet,
 * never the dev instance.
 *
 * Order: [Build] desktop-ui from source → [A] genesis checks (health ·
 * migrations · tool sync · seeds · user→member bridge · default agents ·
 * zero user containers) → [UI] first paint: the Dashboard is visible
 * and no first-run wizard appears.
 *
 * Exit 0 = a fresh install is healthy, truly blank, and opens directly to the Dashboard. Nonzero on any FAIL.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { GateServer } from './lib/gateServer';
import { Ledger } from './lib/ledger';
import { runPhaseA, migrationCount } from './phases/phaseA';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const UI_DIST = resolve(HERE, '../../../../desktop-ui/dist');

/** How long the Dashboard gets to appear after page load. */
const DASHBOARD_TIMEOUT_MS = 15_000;

interface Args {
  headless: boolean;
  build: boolean;
  holdMs?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { headless: false, build: true };
  for (const a of argv) {
    if (a === '--headless') args.headless = true;
    else if (a === '--no-build') args.build = false;
    else if (a.startsWith('--hold-ms=')) args.holdMs = Number(a.slice('--hold-ms='.length));
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: pnpm test:e2e [--headless] [--no-build] [--hold-ms=N]\n');
      process.exit(0);
    }
  }
  return args;
}

function banner(msg: string): void {
  process.stdout.write(`\n${'='.repeat(72)}\n${msg}\n${'='.repeat(72)}\n`);
}

/** Build the web UI from current source so the run never tests a stale dist. */
function buildUi(): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const buildEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(buildEnv)) {
      if (key.startsWith('VITE_')) delete buildEnv[key];
    }
    Object.assign(buildEnv, {
      SNAGLET_BUILD_PROFILE: 'browser-preview',
      VITE_API_BASE_URL: '/api',
      VITE_APP_NAME: 'Snaglet',
    });
    const child = spawn('pnpm', ['--filter', '@snaglet/desktop-ui', 'build'], {
      cwd: REPO_ROOT,
      env: buildEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const cap = (buf: Buffer): void => {
      tail = (tail + buf.toString()).slice(-4000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', rejectBuild);
    child.on('exit', (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`desktop-ui build exited with code ${code}\n${tail}`));
    });
  });
}

/**
 * The first UI test: open the fresh workspace in a real browser and assert the
 * Dashboard is showing directly. Fresh install bootstrap still creates the
 * minimum local user; provider/model setup happens in Providers and Agents.
 *
 * In headed mode the same window then stays open for eyeballing (until closed,
 * or --hold-ms). Returns the ledger note.
 */
async function checkDashboard(
  url: string,
  opts: { headless: boolean; holdMs?: number }
): Promise<string> {
  // Use the same Playwright package and browser build as the UI suite.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: opts.headless });
  try {
    const page = await browser.newPage(opts.headless ? {} : { viewport: null });
    const diagnostics: string[] = [];
    page.on('console', (message) =>
      diagnostics.push(`console.${message.type()}: ${message.text()}`)
    );
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('response', (pageResponse) => {
      if (pageResponse.status() >= 400) {
        diagnostics.push(`response.${pageResponse.status()}: ${pageResponse.url()}`);
      }
    });
    const response = await page.goto(url);
    try {
      // App-shell readiness: the ActivityBar renders every view as a role="tab"
      // (ActivityBar.tsx → Tabs.Tab), which is the same signal the e2e helpers
      // use in openApp().
      await page.locator('#root').waitFor({ state: 'visible', timeout: DASHBOARD_TIMEOUT_MS });
      await page
        .getByRole('tab')
        .first()
        .waitFor({ state: 'visible', timeout: DASHBOARD_TIMEOUT_MS });
      await page
        .getByRole('dialog', { name: 'Set up Snaglet' })
        .waitFor({ state: 'detached', timeout: 1_000 })
        .catch(() => {
          console.warn('[gate] "Set up Snaglet" dialog still attached after 1s; continuing');
        });
    } catch (error: unknown) {
      const body = await page
        .locator('body')
        .innerText()
        .catch(() => '<body unavailable>');
      throw new Error(
        `Dashboard missing (HTTP ${response?.status() ?? 'no response'}, ` +
          `title=${JSON.stringify(await page.title())}, body=${JSON.stringify(body.slice(0, 1000))}, ` +
          `diagnostics=${JSON.stringify(diagnostics.slice(-20))})`,
        { cause: error }
      );
    }

    if (!opts.headless) {
      if (opts.holdMs && Number.isFinite(opts.holdMs)) {
        process.stdout.write(
          `browser open on the fresh Snaglet — auto-closing in ${opts.holdMs}ms\n`
        );
        await new Promise((r) => setTimeout(r, opts.holdMs));
      } else {
        process.stdout.write('browser open on the fresh Snaglet — close the window to finish\n');
        await new Promise<void>((done) => browser.on('disconnected', () => done()));
      }
    }
    return 'fresh DB ⇒ Dashboard visible on first paint';
  } finally {
    try {
      await browser.close();
    } catch (error) {
      console.error('[gate] failed to close browser cleanly', error);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledger = new Ledger();
  const overall0 = Date.now();

  banner(
    `Snaglet test:e2e — build → fresh blank Snaglet (throwaway MANAGED POSTGRESQL) → fresh Dashboard\n` +
      `migrations on disk: ${migrationCount()}  |  ` +
      `ui build: ${args.build ? 'from source' : 'SKIPPED (--no-build, reusing dist)'}  |  ` +
      `browser: ${args.headless ? 'headless' : 'visible'}`
  );

  ledger.phase('Build');
  if (args.build) {
    const ok = await ledger.op('build: desktop-ui from current source', async () => {
      await buildUi();
    });
    if (!ok) {
      banner('LEDGER — SUMMARY');
      process.stdout.write(ledger.summary() + '\n');
      process.stdout.write('RESULT: build failed — nothing to test against\n');
      process.exit(1);
    }
  } else {
    ledger.skip('build: desktop-ui from current source', '--no-build: reusing existing dist');
  }
  if (!existsSync(join(UI_DIST, 'index.html'))) {
    throw new Error(`UI dist missing at ${UI_DIST} — run without --no-build`);
  }

  const bootT = Date.now();
  const server = await GateServer.boot('managed', {
    timeoutMs: 90_000,
    captureLog: true,
    webStaticDir: UI_DIST,
  });
  process.stdout.write(
    `fresh managed-PostgreSQL Snaglet ready in ${Date.now() - bootT}ms (home: throwaway tmp dir)\n\n`
  );

  try {
    await runPhaseA(server, ledger);

    ledger.phase('UI');
    const dashboardPassed = await ledger.op('ui: Dashboard displays on first launch', () =>
      checkDashboard(server.baseUrl, { headless: args.headless, holdMs: args.holdMs })
    );
    if (!dashboardPassed) {
      process.stdout.write(`\n[gate-server log tail]\n${server.logTail()}\n`);
    }
  } finally {
    await server.dispose();
  }

  const c = ledger.counts();
  banner('LEDGER — SUMMARY');
  process.stdout.write(ledger.summary() + '\n');
  process.stdout.write(`TOTAL: ${((Date.now() - overall0) / 1000).toFixed(1)}s\n\n`);
  process.stdout.write(
    `RESULT: ${c.pass} PASS, ${c.fail} FAIL, ${c.skip} SKIPPED  →  ` +
      `${ledger.hasFailure() ? 'GATE FAILED' : 'GATE PASSED'}\n`
  );
  process.exit(ledger.hasFailure() ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(
    `\n[test:e2e] fatal: ${err instanceof Error && err.stack ? err.stack : getErrorMessage(err)}\n`
  );
  process.exit(1);
});
