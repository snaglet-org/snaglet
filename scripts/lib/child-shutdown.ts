import { spawnSync, type ChildProcess } from 'node:child_process';

export async function requestServerShutdown(
  baseUrl: string,
  shutdownToken: string,
  authToken?: string
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/server/shutdown`, {
    method: 'POST',
    headers: {
      'x-snaglet-shutdown-token': shutdownToken,
      ...(authToken ? { 'x-snaglet-token': authToken } : {}),
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 202) throw new Error(`Server rejected shutdown (${response.status})`);
}

export function requestWindowsClose(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) throw new Error('Cannot close a desktop process without a PID');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `if (-not (Get-Process -Id ${child.pid}).CloseMainWindow()) { exit 1 }`,
    ],
    {
      windowsHide: true,
      timeout: 5_000,
    }
  );
  if (result.error || result.status !== 0)
    throw new Error('Could not request normal desktop close', { cause: result.error });
}
