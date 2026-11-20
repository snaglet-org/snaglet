import { EventEmitter } from 'node:events';
import {
  IDLE_STOP_MS,
  SystemCursorOverlayLauncher,
  overlayUrls,
  type OverlayLauncherDeps,
} from '@server/services/systemCursorOverlayLauncher';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4242;
  kill = jest.fn(() => {
    this.signalCode = 'SIGTERM';
    this.emit('exit', null, 'SIGTERM');
    return true;
  });
}

function setup(overrides: Partial<OverlayLauncherDeps> = {}) {
  let now = 1_000_000;
  let holder: string | null = 'agent-a';
  const children: FakeChild[] = [];
  const spawn = jest.fn((_bin: string, _args: string[], _env: NodeJS.ProcessEnv) => {
    const c = new FakeChild();
    children.push(c);
    return c as never;
  });
  const launcher = new SystemCursorOverlayLauncher({
    platform: 'darwin',
    env: { PORT: '61983', NODE_ENV: 'production', SNAGLET_AUTH_TOKEN: 'secret' },
    now: () => now,
    exists: () => true,
    spawn,
    holderAgentId: () => holder,
    overlayAlive: () => false,
    ...overrides,
  });
  return {
    launcher,
    spawn,
    children,
    tick: (ms: number) => (now += ms),
    setHolder: (h: string | null) => (holder = h),
  };
}

describe('SystemCursorOverlayLauncher', () => {
  it('spawns the overlay once on claim, pointed at the sidecar, token only in env', () => {
    const { launcher, spawn } = setup();
    launcher.ensure();
    launcher.ensure();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, env] = spawn.mock.calls[0];
    expect(args).toEqual(['http://127.0.0.1:61983/?cursorOverlay=1', 'http://127.0.0.1:61983']);
    expect(args.join(' ')).not.toContain('secret');
    expect(env.SNAGLET_AUTH_TOKEN).toBe('secret');
    expect(env.SNAGLET_OVERLAY_PARENT_PID).toBe(String(process.pid));
    launcher.stop();
  });

  it('hands the overlay only the session token and what a macOS app needs, no other secret', () => {
    const { launcher, spawn } = setup({
      env: {
        PORT: '61983',
        NODE_ENV: 'production',
        HOME: '/Users/test',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/tmp/test/',
        LANG: 'en_US.UTF-8',
        SNAGLET_AUTH_TOKEN: 'test-auth-token',
        SNAGLET_PANEL_TOKEN: 'test-panel-token',
        SNAGLET_SHUTDOWN_TOKEN: 'test-shutdown-token',
        SNAGLET_EXPORT_GRANT_KEY: 'test-export-key',
        CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key',
        ANTHROPIC_API_KEY: 'test-provider-key',
      },
    });
    launcher.ensure();
    const [, , env] = spawn.mock.calls[0];
    expect(env).toEqual({
      HOME: '/Users/test',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp/test/',
      LANG: 'en_US.UTF-8',
      SNAGLET_AUTH_TOKEN: 'test-auth-token',
      SNAGLET_OVERLAY_PARENT_PID: String(process.pid),
    });
    launcher.stop();
  });

  it('does nothing off macOS, when disabled, when a hand-started overlay is alive, or unbuilt', () => {
    for (const o of [
      { platform: 'linux' },
      { env: { PORT: '1', SNAGLET_CURSOR_OVERLAY: 'off' } },
      { overlayAlive: () => true },
      { exists: () => false },
    ] as Partial<OverlayLauncherDeps>[]) {
      const { launcher, spawn } = setup(o);
      launcher.ensure();
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('stops after the cursor has been free for IDLE_STOP_MS, not while held', () => {
    const { launcher, children, tick, setHolder } = setup();
    launcher.ensure();
    tick(IDLE_STOP_MS * 2);
    launcher.checkIdle();
    expect(children[0].kill).not.toHaveBeenCalled();
    setHolder(null);
    tick(IDLE_STOP_MS - 1);
    launcher.checkIdle();
    expect(children[0].kill).not.toHaveBeenCalled();
    tick(1);
    launcher.checkIdle();
    expect(children[0].kill).toHaveBeenCalled();
    expect(launcher.isRunning()).toBe(false);
  });

  it('respawns after the overlay exits, with a backoff', () => {
    const { launcher, spawn, children, tick } = setup();
    launcher.ensure();
    children[0].exitCode = 0;
    children[0].emit('exit', 0, null);
    launcher.ensure();
    expect(spawn).toHaveBeenCalledTimes(1);
    tick(15_000);
    launcher.ensure();
    expect(spawn).toHaveBeenCalledTimes(2);
    launcher.stop();
  });

  it('uses the Vite UI in dev and the sidecar origin when it serves the UI', () => {
    expect(overlayUrls({ PORT: '4001', NODE_ENV: 'development', CLIENT_PORT: '3001' })).toEqual({
      page: 'http://localhost:3001/?cursorOverlay=1',
      api: 'http://127.0.0.1:4001',
    });
    expect(
      overlayUrls({ PORT: '4001', NODE_ENV: 'development', SNAGLET_WEB_STATIC_DIR: '/x' })?.page
    ).toBe('http://127.0.0.1:4001/?cursorOverlay=1');
    expect(overlayUrls({})).toBeNull();
  });
});
