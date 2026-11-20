/**
 * Server status & control routes.
 * Mounted before apiRateLimiter — never throttle internal monitoring.
 */
import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { spawn } from 'node:child_process';
import { serverConfig } from '@server/config';
import { logDirectory } from '@server/config/logger';
import type { ServerStatusResponse } from '@snaglet/shared/types';
import { formatTimestamp, formatUptime, formatBytes } from '@snaglet/shared/utils';
import { updateCheckService } from '@server/services/UpdateCheckService';
import { findCurrentLogFile, followLogFile, readLogSnapshot } from '@server/utils/logTail';

const router = Router();
let requestShutdown: (() => Promise<void>) | null = null;
let shutdownRequested = false;

export function configureServerShutdown(handler: () => Promise<void>): void {
  requestShutdown = handler;
  shutdownRequested = false;
}

function tokensMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * GET /api/server/status
 * Combined uptime + memory snapshot. Powers the ServerCard.
 */
router.get('/status', (_req: Request, res: Response) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();

  const response: ServerStatusResponse = {
    status: 'healthy',
    port: serverConfig.port,
    uptime: {
      seconds: Math.floor(uptime),
      human: formatUptime(uptime),
    },
    memory: {
      heapUsed: formatBytes(mem.heapUsed),
      heapTotal: formatBytes(mem.heapTotal),
      rss: formatBytes(mem.rss),
    },
    timestamp: formatTimestamp(),
  };
  res.json(response);
});

/**
 * GET /api/server/update-status — cached snapshot of the daily GitHub
 * release check (no network). Powers the update banner/button.
 */
router.get('/update-status', async (_req: Request, res: Response) => {
  const status = await updateCheckService.status();
  res.json(status);
});

/**
 * POST /api/server/update-check — force a check now (bypasses the daily
 * cadence, keeps per-version notification dedupe). Returns fresh status.
 */
router.post('/update-check', async (_req: Request, res: Response) => {
  const status = await updateCheckService.checkNow();
  res.json(status);
});

/**
 * POST /api/server/pick-folder
 * Opens a native folder-selection dialog on the host and returns the chosen
 * absolute path. This backs the folder picker in *browser* mode (the Tauri
 * shell uses its own `pick_folder` command via rfd). It works because the Snaglet
 * server runs locally on the user's machine, so it can surface a GUI dialog.
 *
 * Responds `{ path: string | null }` — `null` when the user cancels or no
 * native dialog tool is available (e.g. headless host).
 */
router.post('/pick-folder', async (_req: Request, res: Response) => {
  const path = await openNativeFolderDialog();
  res.json({ path });
});

/**
 * Spawn the platform-appropriate native folder picker and resolve to the
 * selected absolute path (or null on cancel / unsupported host). Never
 * rejects — a missing dialog tool or user cancel resolves to null.
 */
function openNativeFolderDialog(): Promise<string | null> {
  const TITLE = 'Select Project Folder';

  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      cmd = 'osascript';
      args = ['-e', `POSIX path of (choose folder with prompt "${TITLE}")`];
      break;
    case 'win32':
      cmd = 'powershell.exe';
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${TITLE}'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`,
      ];
      break;
    default:
      // Linux / other: prefer zenity (GTK). Falls through to null if absent.
      cmd = 'zenity';
      args = ['--file-selection', '--directory', `--title=${TITLE}`];
      break;
  }

  return new Promise((resolve) => {
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: process.platform === 'win32' });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(null)); // tool not installed
    child.on('close', (code) => {
      // Non-zero exit means the user canceled (or the tool failed).
      if (code !== 0) {
        resolve(null);
        return;
      }
      // Native dialogs return an absolute path; trim whitespace + any
      // trailing slash osascript appends (but keep a bare root "/").
      let picked = stdout.trim();
      if (picked.length > 1) picked = picked.replace(/\/+$/, '');
      resolve(picked.length > 0 ? picked : null);
    });
  });
}

/**
 * POST /api/server/stop
 * Gracefully shuts down the server process.
 * Sends response first, then exits after a short delay.
 */
router.post('/stop', (_req: Request, res: Response) => {
  if (!requestShutdown) {
    res.status(503).json({ error: 'Shutdown is not available' });
    return;
  }
  res.status(202).json({ accepted: true });
  void requestShutdown();
});

router.post('/shutdown', (req: Request, res: Response) => {
  const expected = process.env.SNAGLET_SHUTDOWN_TOKEN;
  const presented = req.get('x-snaglet-shutdown-token');
  if (!expected || !presented || !tokensMatch(presented, expected)) {
    res.status(403).json({ error: 'Unauthorized shutdown request' });
    return;
  }
  if (!requestShutdown) {
    res.status(503).json({ error: 'Shutdown is not available' });
    return;
  }
  if (!shutdownRequested) {
    shutdownRequested = true;
    res.once('finish', () => void requestShutdown?.());
  }
  res.status(202).json({ accepted: true });
});

/**
 * GET /api/server/logs
 * SSE endpoint — streams the active file transport and follows new lines.
 */
router.get('/logs', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (line: string) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);
  let tail: ReturnType<typeof followLogFile> | undefined;
  let closed = false;
  req.once('close', () => {
    closed = true;
    tail?.close();
    res.end();
  });

  const logFile = await findCurrentLogFile(logDirectory);
  if (closed) return;
  if (!logFile) {
    send('[No log file found for today.]');
    return;
  }

  try {
    const snapshot = await readLogSnapshot(logFile, 100);
    if (closed) return;
    for (const line of snapshot.lines) send(line);
    tail = followLogFile(logFile, snapshot.size, snapshot.identity, (line) => {
      if (line.trim()) send(line);
    });
  } catch {
    if (!closed) send('[Unable to read log file.]');
  }
});

export default router;
