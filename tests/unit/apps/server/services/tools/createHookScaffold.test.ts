import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { stop as stopEsbuild } from 'esbuild';
import { buildHookBundle } from '@server/services/customHooks/buildHookBundle';
import {
  writeHookScaffold,
  validateHookName,
  LEGACY_BUILD_RELATIVE,
} from '@server/services/ToolService/handlers/hooks/scaffold';

describe('hook tool, op create scaffold', () => {
  let hooksDir: string;
  let outDir: string;

  beforeEach(async () => {
    hooksDir = await mkdtemp(path.join(tmpdir(), 'snaglet-create-hook-'));
    outDir = await mkdtemp(path.join(tmpdir(), 'snaglet-create-hook-out-'));
  });

  afterEach(async () => {
    await rm(hooksDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it('generates a hook that actually compiles against the vendored SDK', async () => {
    const scaffold = await writeHookScaffold(hooksDir, {
      name: 'notify-on-task-done',
      description: 'Says something when a task row changes.',
      events: ['table_entry:update'],
    });

    expect(scaffold.hookName).toBe('notify-on-task-done');
    const source = await readFile(path.join(scaffold.folderPath, 'hook.ts'), 'utf8');
    expect(source).toContain("import { defineHook, snaglet } from '@snaglet/sdk'");
    expect(source).toContain("on: ['table_entry:update']");
    expect(source).toContain('Says something when a task row changes.');

    // The scaffold is worthless if it does not build — a hook that fails to
    // compile registers as `failed` and can never be enabled.
    const built = await buildHookBundle(scaffold.folderPath, path.join(outDir, 'hook.cjs'));
    expect(built.success).toBe(true);
  });

  it('writes hook source only — never a build artifact, which would auto-enable it', async () => {
    // The activation gate: HookRegistryService enables a hook on first
    // registration when an in-folder build already exists. A scaffold
    // that emitted one would hand agent-authored code an enabled
    // registration and skip human review entirely.
    const scaffold = await writeHookScaffold(hooksDir, {
      name: 'source-only',
      description: 'Only hook.ts belongs on disk.',
      events: ['message:create'],
    });

    expect(await readdir(scaffold.folderPath)).toEqual(['hook.ts']);
    await expect(
      readFile(path.join(scaffold.folderPath, LEGACY_BUILD_RELATIVE), 'utf8')
    ).rejects.toThrow();
  });

  it('never replaces an existing hook, because registration preserves enablement', async () => {
    // The activation escape hatch this closes: HookRegistrations.discover
    // updates only source_path/updated_at on conflict, so `enabled` survives a
    // re-registration. Writing new code into a folder a person had already
    // enabled would put that code on the live bus — subscribed before any
    // caller could inspect the outcome. Creating only is what prevents it.
    const folderPath = path.join(hooksDir, 'already-enabled-by-a-person');
    await mkdir(folderPath, { recursive: true });
    await writeFile(path.join(folderPath, 'hook.ts'), '// code a human reviewed and enabled');

    await expect(
      writeHookScaffold(hooksDir, {
        name: 'already-enabled-by-a-person',
        description: 'Should never land.',
        events: ['message:create'],
      })
    ).rejects.toThrow(/already exists/);

    // The existing hook's source is untouched — no destructive replacement.
    expect(await readFile(path.join(folderPath, 'hook.ts'), 'utf8')).toBe(
      '// code a human reviewed and enabled'
    );
  });

  it('points at file_edit when the name is taken, rather than just failing', async () => {
    await writeHookScaffold(hooksDir, {
      name: 'taken',
      description: 'First one wins.',
      events: ['message:create'],
    });

    await expect(
      writeHookScaffold(hooksDir, {
        name: 'taken',
        description: 'Second one is refused.',
        events: ['message:create'],
      })
    ).rejects.toThrow(/file\(op:update\)/);
  });

  it('refuses a definition that could never register', async () => {
    // defineHook rejects a definition with neither `on` nor `schedule`; catching
    // it here beats writing a file that fails registration with a vaguer error.
    await expect(
      writeHookScaffold(hooksDir, { name: 'triggerless', description: 'No triggers.' })
    ).rejects.toThrow(/events .*or hook_source/i);
    await expect(readdir(hooksDir)).resolves.toEqual([]);
  });

  it('keeps supplied hook_source verbatim and lets it declare its own triggers', async () => {
    const custom = `import { defineHook } from '@snaglet/sdk';\n\nexport default defineHook({\n  schedule: { every: 1, unit: 'hour' },\n  async run() {},\n});\n`;
    const scaffold = await writeHookScaffold(hooksDir, {
      name: 'hourly-sweep',
      description: 'Ignored in favor of the supplied source.',
      hookSource: custom,
    });

    expect(await readFile(path.join(scaffold.folderPath, 'hook.ts'), 'utf8')).toBe(custom);
  });

  it('rejects names that would escape or confuse the hooks directory', async () => {
    for (const bad of ['../escape', 'Has Caps', 'trailing-', 'under_score', '']) {
      expect(() => validateHookName(bad)).toThrow();
    }
    expect(validateHookName('  spaced-name  ')).toBe('spaced-name');
  });

  it('leaves no staging directory behind when a write fails', async () => {
    await expect(
      writeHookScaffold(hooksDir, {
        name: 'doomed',
        description: '',
        events: ['message:create'],
      })
    ).rejects.toThrow(/description is required/);

    // Dot-prefixed staging folders are invisible to the scanner, but they must
    // still not accumulate.
    expect(await readdir(hooksDir)).toEqual([]);
  });
});

afterAll(() => stopEsbuild());
