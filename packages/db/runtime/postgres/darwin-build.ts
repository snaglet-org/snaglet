import { execFile, type ExecFileOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getErrorMessage } from '@snaglet/shared/utils';
import { POSTGRES_MINIMUM_MACOS_VERSION } from './version';

const execFileAsync = promisify(execFile);
type Execute = (command: string, args: string[], options: ExecFileOptions) => Promise<string>;

interface DarwinBuildOptions {
  env?: NodeJS.ProcessEnv;
  execute?: Execute;
  log?: (line: string) => void;
}

/** Check the compiler/SDK pair before downloading sources; never change system settings. */
export async function resolveDarwinBuildEnvironment(
  options: DarwinBuildOptions = {}
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    MACOSX_DEPLOYMENT_TARGET: POSTGRES_MINIMUM_MACOS_VERSION,
  };
  const execute: Execute =
    options.execute ??
    (async (command, args, settings) => {
      const result = await execFileAsync(command, args, { ...settings, encoding: 'utf8' });
      return result.stdout;
    });
  const settings: ExecFileOptions = { env, timeout: 30_000, maxBuffer: 1024 * 1024 };
  const candidates: string[] = [];
  if (env.SDKROOT?.trim()) {
    // An explicit SDK is a user choice, not something to silently override.
    candidates.push(env.SDKROOT);
  } else {
    try {
      const selected = (
        await execute('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], settings)
      ).trim();
      if (selected) candidates.push(selected, path.join(path.dirname(selected), 'MacOSX.sdk'));
      const developer = (await execute('/usr/bin/xcode-select', ['-p'], settings)).trim();
      if (developer) {
        candidates.push(path.join(developer, 'SDKs', 'MacOSX.sdk'));
        candidates.push(
          path.join(developer, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk')
        );
      }
    } catch (error: unknown) {
      throw new Error(
        `Cannot find the macOS build tools. Run xcode-select --install, finish installation, then retry pnpm dev. ${getErrorMessage(error)}`
      );
    }
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'snaglet-pg-compiler-'));
  const source = path.join(scratch, 'probe.c');
  const binary = path.join(scratch, 'probe');
  const failures: string[] = [];
  try {
    await writeFile(
      source,
      '#include <stdio.h>\nint main(void) { puts("snaglet-compiler-ok"); return 0; }\n'
    );
    for (const sdk of new Set(candidates)) {
      const buildEnv = { ...env, SDKROOT: sdk };
      try {
        // Like configure, support CC wrappers and build flags. Values are shell
        // expansions, never interpolated/evaluated as shell source; paths are argv.
        await execute(
          '/bin/sh',
          [
            '-c',
            '${CC:-cc} $CPPFLAGS $CFLAGS "$1" $LDFLAGS -o "$2"',
            'snaglet-pg-compiler',
            source,
            binary,
          ],
          { ...settings, env: buildEnv }
        );
        await execute(binary, [], { ...settings, env: buildEnv });
        options.log?.(`macOS compiler verified with SDK ${sdk}`);
        return buildEnv;
      } catch (error: unknown) {
        failures.push(`${sdk}: ${getErrorMessage(error)}`);
        options.log?.(`macOS SDK probe failed: ${sdk}`);
      }
    }
    throw new Error(
      `No working macOS compiler/SDK pair. Install or update Apple's Command Line Tools (xcode-select --install / Software Update), or set SDKROOT to a compatible installed macOS SDK. Retry pnpm dev.\n${failures.join('\n')}`
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
