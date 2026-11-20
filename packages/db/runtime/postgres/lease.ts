import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import * as path from 'node:path';

/** Windows removes this exclusive pipe when its owning process exits. */
export async function withWindowsPostgresLease<T>(
  dataDir: string,
  operation: () => Promise<T>,
  timeoutMs = 120_000
): Promise<T> {
  await mkdir(path.dirname(dataDir), { recursive: true });
  const parent = await realpath(path.dirname(dataDir));
  let canonical = path.join(parent, path.basename(dataDir));
  try {
    canonical = await realpath(dataDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  canonical = canonical.toLowerCase();
  const key = createHash('sha256').update(canonical).digest('hex');
  const pipe = `\\\\.\\pipe\\snaglet-postgres-runtime-${key}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: pipe, exclusive: true }, resolve);
      });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for PostgreSQL runtime ownership at ${dataDir}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      return await operation();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
}
