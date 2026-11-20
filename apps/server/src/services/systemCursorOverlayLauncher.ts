/**
 * Starts the native system-wide cursor overlay (native/cursor-overlay) when an agent takes the
 * cursor, so its flower and narration bubble are drawn over the whole screen instead of only
 * inside the Snaglet window.
 *
 * Lifecycle: spawned on demand (claim / cursor activity), stopped once nobody has held the
 * cursor for IDLE_STOP_MS, on server shutdown, and by the overlay itself when the server's
 * process goes away (SNAGLET_OVERLAY_PARENT_PID). The overlay is click-through by construction
 * (see tests/unit/apps/desktop/cursorOverlaySafety.test.ts). macOS only; never throws.
 *
 * Opt out with SNAGLET_CURSOR_OVERLAY=off. Override the binary with SNAGLET_CURSOR_OVERLAY_BIN and the
 * page with SNAGLET_CURSOR_OVERLAY_URL.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { cursorClaimService } from '@server/services/CursorClaimService';
import { isSystemOverlayActive } from '@server/services/systemCursorOverlay';

/** Stop the overlay after this long with no cursor holder. */
export const IDLE_STOP_MS = 60_000;
const IDLE_CHECK_MS = 10_000;
/** Don't respawn a crashing overlay more often than this. */
const RESPAWN_BACKOFF_MS = 15_000;
const DEV_CLIENT_PORT_FALLBACK = 3001;

export interface OverlayLauncherDeps {
  platform: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  exists: (path: string) => boolean;
  spawn: (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  holderAgentId: () => string | null;
  overlayAlive: () => boolean;
}

function helperDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev/tests: apps/server/src/services → apps/server/native/cursor-overlay.
  const devDir = join(here, '..', '..', 'native', 'cursor-overlay');
  if (existsSync(devDir)) return devDir;
  // Bundle: server.mjs (dist/bundle) → dist/bundle/native/cursor-overlay.
  return join(here, 'native', 'cursor-overlay');
}

function cursorOverlayBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SNAGLET_CURSOR_OVERLAY_BIN || join(helperDir(), 'bin', 'snaglet-cursor-overlay');
}

/**
 * Where the overlay loads its page and posts Esc. The packaged sidecar serves the UI itself
 * (same origin as the API); a dev server leaves the UI to Vite on CLIENT_PORT.
 */
export function overlayUrls(env: NodeJS.ProcessEnv): { page: string; api: string } | null {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) return null;
  const api = `http://127.0.0.1:${port}`;
  if (env.SNAGLET_CURSOR_OVERLAY_URL) return { page: env.SNAGLET_CURSOR_OVERLAY_URL, api };
  const servesUi = env.NODE_ENV !== 'development' || Boolean(env.SNAGLET_WEB_STATIC_DIR);
  const uiBase = servesUi
    ? api
    : `http://localhost:${Number(env.CLIENT_PORT) || DEV_CLIENT_PORT_FALLBACK}`;
  return { page: `${uiBase}/?cursorOverlay=1`, api };
}

/**
 * What the overlay app needs to start, plus the session token it sends as `x-snaglet-token`.
 * The rest of the server's environment (the panel token, the credential encryption key,
 * provider keys) never reaches it.
 */
const OVERLAY_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'TMPDIR',
  'LANG',
  'SNAGLET_AUTH_TOKEN',
];

function overlayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const key of OVERLAY_ENV_KEYS) {
    if (env[key] !== undefined) picked[key] = env[key];
  }
  // Lets the overlay quit if this server dies uncleanly.
  picked.SNAGLET_OVERLAY_PARENT_PID = String(process.pid);
  return picked;
}

export class SystemCursorOverlayLauncher {
  private child: ChildProcess | null = null;
  private lastSpawnAt = Number.NEGATIVE_INFINITY;
  private lastHeldAt = Number.NEGATIVE_INFINITY;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private warnedMissing = false;

  constructor(private readonly deps: OverlayLauncherDeps) {}

  private enabled(): boolean {
    if (this.deps.platform !== 'darwin') return false;
    if (this.deps.env.NODE_ENV === 'test' && !this.deps.env.SNAGLET_CURSOR_OVERLAY_BIN)
      return false;
    const flag = this.deps.env.SNAGLET_CURSOR_OVERLAY?.trim().toLowerCase();
    return flag !== 'off' && flag !== '0' && flag !== 'false';
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Make sure the overlay is up while an agent holds the cursor. Cheap to call often. */
  ensure(): void {
    try {
      if (!this.enabled()) return;
      const now = this.deps.now();
      this.lastHeldAt = now;
      if (this.isRunning()) return;
      // One started by hand (run.sh) is already heartbeating: don't draw a second one.
      if (this.deps.overlayAlive()) return;
      if (now - this.lastSpawnAt < RESPAWN_BACKOFF_MS) return;
      const bin = cursorOverlayBinaryPath(this.deps.env);
      if (!this.deps.exists(bin)) {
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          logger.warn(
            `[cursor-overlay] ${bin} not built; agent flowers stay inside the Snaglet window ` +
              '(build: bash apps/server/native/cursor-overlay/build.sh)'
          );
        }
        return;
      }
      const urls = overlayUrls(this.deps.env);
      if (!urls) return;
      this.lastSpawnAt = now;
      // The session token (if any) reaches the overlay through its environment, never argv.
      const child = this.deps.spawn(bin, [urls.page, urls.api], overlayEnv(this.deps.env));
      child.on('error', (err) => logger.warn(`[cursor-overlay] spawn failed: ${err.message}`));
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      this.child = child;
      this.startIdleWatch();
      logger.info(`[cursor-overlay] started system overlay (pid ${child.pid ?? '?'})`);
    } catch (err) {
      logger.warn(`[cursor-overlay] could not start: ${getErrorMessage(err)}`);
    }
  }

  /** Called on a timer: stop once no agent has held the cursor for IDLE_STOP_MS. */
  checkIdle(): void {
    if (!this.isRunning()) return this.stopIdleWatch();
    if (this.deps.holderAgentId()) {
      this.lastHeldAt = this.deps.now();
      return;
    }
    if (this.deps.now() - this.lastHeldAt >= IDLE_STOP_MS) this.stop();
  }

  stop(): void {
    this.stopIdleWatch();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  private startIdleWatch(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}

export const systemCursorOverlayLauncher = new SystemCursorOverlayLauncher({
  platform: process.platform,
  env: process.env,
  now: Date.now,
  exists: existsSync,
  spawn: (bin, args, env) => spawn(bin, args, { env, stdio: 'ignore' }),
  holderAgentId: () => cursorClaimService.holderAgentId(),
  overlayAlive: () => isSystemOverlayActive(),
});
