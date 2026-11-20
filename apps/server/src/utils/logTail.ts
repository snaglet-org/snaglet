import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface LogFileIdentity {
  device: number;
  inode: number;
}

export interface LogSnapshot {
  identity: LogFileIdentity;
  lines: string[];
  size: number;
}

export interface FileTail {
  close(): void;
}

interface FollowLogOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const READ_CHUNK_BYTES = 64 * 1024;

function identityOf(metadata: { dev: number; ino: number }): LogFileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function isSameFile(left: LogFileIdentity, right: LogFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** Finds the file transport's current log, with support for legacy combined logs. */
export async function findCurrentLogFile(logDirectory: string): Promise<string | null> {
  const current = path.join(logDirectory, 'server.log');
  try {
    if ((await stat(current)).isFile()) return current;
  } catch {
    // A server can be configured console-only, or can be starting before its
    // file transport has opened the log.
  }

  try {
    const entries = await readdir(logDirectory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^combined-.*\.log$/.test(entry.name))
        .map(async (entry) => {
          const file = path.join(logDirectory, entry.name);
          return { file, modifiedAt: (await stat(file)).mtimeMs };
        })
    );
    return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.file ?? null;
  } catch {
    return null;
  }
}

async function readTail(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  maxLines: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let position = size;
  let lineBreaks = 0;
  while (position > 0 && lineBreaks <= maxLines) {
    const length = Math.min(READ_CHUNK_BYTES, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const chunk = buffer.subarray(0, bytesRead);
    for (const byte of chunk) {
      if (byte === 10) lineBreaks += 1;
    }
    chunks.unshift(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a bounded tail snapshot so a follower can begin without losing appended lines. */
export async function readLogSnapshot(file: string, maxLines: number): Promise<LogSnapshot> {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    const lines = (await readTail(handle, metadata.size, maxLines))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines);
    return { identity: identityOf(metadata), lines, size: metadata.size };
  } finally {
    await handle.close();
  }
}

/**
 * Polling keeps append, truncation, and replacement behavior consistent across
 * Windows, macOS, network volumes, and filesystems where watch notifications
 * are incomplete. The caller owns the returned close function.
 */
export function followLogFile(
  file: string,
  startOffset: number,
  startIdentity: LogFileIdentity,
  onLine: (line: string) => void,
  options: FollowLogOptions = {}
): FileTail {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let closed = false;
  let reading = false;
  let identity = startIdentity;
  let offset = startOffset;
  let pending = '';
  let decoder = new StringDecoder('utf8');

  const reset = (nextIdentity: LogFileIdentity): void => {
    identity = nextIdentity;
    offset = 0;
    pending = '';
    decoder = new StringDecoder('utf8');
  };

  const deliver = (text: string): void => {
    const parts = `${pending}${text}`.split('\n');
    pending = parts.pop() ?? '';
    for (const rawLine of parts) {
      if (closed) return;
      onLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  };

  const poll = async (): Promise<void> => {
    if (closed || reading) return;
    reading = true;
    try {
      const handle = await open(file, 'r');
      try {
        const metadata = await handle.stat();
        const nextIdentity = identityOf(metadata);
        if (!isSameFile(identity, nextIdentity) || metadata.size < offset) reset(nextIdentity);
        while (!closed && offset < metadata.size) {
          const length = Math.min(READ_CHUNK_BYTES, metadata.size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (closed) return;
          deliver(decoder.write(buffer.subarray(0, bytesRead)));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // A rotation can briefly remove the active path. A later poll will pick
      // up its replacement and reset the offset when its identity changes.
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(() => void poll(), pollIntervalMs);
  return {
    close(): void {
      closed = true;
      clearInterval(timer);
    },
  };
}
