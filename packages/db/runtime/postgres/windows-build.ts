import { execFile, type ExecFileOptions } from 'node:child_process';
import { access } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENV_MARKER = '__SNAGLET_PG_MSVC_ENVIRONMENT__';
const PREREQUISITE =
  'Building pgvector on Windows requires Visual Studio 2022 Build Tools with Desktop development with C++ (MSVC x64/x86 tools and Windows SDK). Install that workload, then retry pnpm pg:runtime:build --strict.';

type Execute = (command: string, args: string[], options: ExecFileOptions) => Promise<string>;

interface WindowsBuildOptions {
  env?: NodeJS.ProcessEnv;
  execute?: Execute;
  exists?: (file: string) => Promise<boolean>;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** `set` output includes values containing '=' and hidden drive-current-directory keys. */
export function parseWindowsBuildEnvironment(output: string): NodeJS.ProcessEnv {
  const lines = output.split(/\r?\n/);
  const marker = lines.indexOf(ENV_MARKER);
  if (marker < 0) throw new Error('Visual Studio did not return its build environment');
  const env: NodeJS.ProcessEnv = {};
  for (const line of lines.slice(marker + 1)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).toUpperCase();
    env[name] = line.slice(separator + 1);
  }
  delete env.SNAGLET_PG_VSDEVCMD;
  if (
    env.VSCMD_ARG_TGT_ARCH !== 'x64' ||
    env.VSCMD_ARG_HOST_ARCH !== 'x64' ||
    !env.VCTOOLSINSTALLDIR ||
    !env.WINDOWSSDKDIR ||
    !env.PATH ||
    !env.INCLUDE ||
    !env.LIB
  ) {
    throw new Error(`Visual Studio returned an incomplete x64 build environment. ${PREREQUISITE}`);
  }
  return env;
}

/** Build-only discovery: packaged runtime startup never invokes a compiler or this helper. */
export async function resolveWindowsBuildEnvironment(
  options: WindowsBuildOptions = {}
): Promise<NodeJS.ProcessEnv> {
  const inherited = options.env ?? process.env;
  const execute: Execute =
    options.execute ??
    (async (command, args, settings) => {
      const result = await execFileAsync(command, args, {
        ...settings,
        encoding: settings.encoding ?? 'utf8',
      });
      return String(result.stdout);
    });
  const exists =
    options.exists ??
    (async (file: string) => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    });
  const programFiles =
    environmentValue(inherited, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!(await exists(vswhere))) throw new Error(PREREQUISITE);
  const settings: ExecFileOptions = {
    env: inherited,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  };
  const installation = (
    await execute(
      vswhere,
      [
        '-latest',
        '-version',
        '[17.0,18.0)',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
        '-utf8',
      ],
      settings
    )
  ).trim();
  if (!installation || !path.isAbsolute(installation) || /[\r\n"\0]/.test(installation)) {
    throw new Error(PREREQUISITE);
  }
  const developerScript = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  if (!(await exists(developerScript))) throw new Error(PREREQUISITE);
  const systemRoot = environmentValue(inherited, 'SystemRoot') ?? 'C:\\Windows';
  // Keep the command text fixed. The quoted path is expanded once by cmd; do
  // not use CALL (which expands '%' a second time), or interpolate paths into
  // shell text. /v:off also keeps literal '!' in custom installation paths.
  const output = await execute(
    path.join(systemRoot, 'System32', 'cmd.exe'),
    [
      '/d',
      '/u',
      '/v:off',
      '/s',
      '/c',
      `""%SNAGLET_PG_VSDEVCMD%" -no_logo -arch=x64 -host_arch=x64 >nul && echo ${ENV_MARKER}&& set"`,
    ],
    {
      ...settings,
      // cmd's `set` must preserve Unicode SDK/user paths regardless of the
      // machine's active OEM code page. vswhere above explicitly emits UTF-8.
      encoding: 'utf16le',
      env: { ...inherited, SNAGLET_PG_VSDEVCMD: developerScript },
      windowsVerbatimArguments: true,
    }
  );
  const environment = parseWindowsBuildEnvironment(output);
  const compilerDirectory = path.join(environment.VCTOOLSINSTALLDIR ?? '', 'bin', 'Hostx64', 'x64');
  for (const executable of ['cl.exe', 'nmake.exe']) {
    if (!(await exists(path.join(compilerDirectory, executable)))) throw new Error(PREREQUISITE);
  }
  return environment;
}
