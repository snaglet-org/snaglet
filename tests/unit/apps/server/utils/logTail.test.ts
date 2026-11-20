import { mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCurrentLogFile, followLogFile, readLogSnapshot } from '@server/utils/logTail';

const waitFor = async (check: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for file tail output');
};

describe('portable log tail', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'snaglet-log-tail-'));
    file = path.join(directory, 'server.log');
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it('uses the active configured transport and returns the last 100 lines', async () => {
    writeFileSync(
      file,
      Array.from({ length: 105 }, (_value, index) => `line-${index}`).join('\n') + '\n'
    );

    await expect(findCurrentLogFile(directory)).resolves.toBe(file);
    const snapshot = await readLogSnapshot(file, 100);
    expect(snapshot.lines).toEqual(
      Array.from({ length: 100 }, (_value, index) => `line-${index + 5}`)
    );
    expect(snapshot.size).toBe(
      Buffer.byteLength(
        Array.from({ length: 105 }, (_value, index) => `line-${index}`).join('\n') + '\n'
      )
    );
    expect(snapshot.identity).toEqual({
      device: expect.any(Number),
      inode: expect.any(Number),
    });
  });

  it('streams appended complete lines', async () => {
    writeFileSync(file, 'existing\n');
    const snapshot = await readLogSnapshot(file, 100);
    const lines: string[] = [];
    const tail = followLogFile(file, snapshot.size, snapshot.identity, (line) => lines.push(line), {
      pollIntervalMs: 10,
    });

    try {
      writeFileSync(file, 'next ', { flag: 'a' });
      writeFileSync(file, 'line\n', { flag: 'a' });
      await waitFor(() => lines.includes('next line'));
      expect(lines).toEqual(['next line']);
    } finally {
      tail.close();
    }
  });

  it('resets its offset after a file truncation', async () => {
    writeFileSync(file, 'existing content\n');
    const snapshot = await readLogSnapshot(file, 100);
    const lines: string[] = [];
    const tail = followLogFile(file, snapshot.size, snapshot.identity, (line) => lines.push(line), {
      pollIntervalMs: 10,
    });

    try {
      truncateSync(file, 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(file, 'replacement\n');
      await waitFor(() => lines.includes('replacement'));
      expect(lines).toEqual(['replacement']);
    } finally {
      tail.close();
    }
  });

  it('stops polling after close', async () => {
    writeFileSync(file, 'existing\n');
    const snapshot = await readLogSnapshot(file, 100);
    const lines: string[] = [];
    const tail = followLogFile(file, snapshot.size, snapshot.identity, (line) => lines.push(line), {
      pollIntervalMs: 10,
    });

    tail.close();
    writeFileSync(file, 'must not arrive\n', { flag: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lines).toEqual([]);
  });

  it('preserves a UTF-8 character split across append polls', async () => {
    writeFileSync(file, 'existing\n');
    const snapshot = await readLogSnapshot(file, 100);
    const lines: string[] = [];
    const tail = followLogFile(file, snapshot.size, snapshot.identity, (line) => lines.push(line), {
      pollIntervalMs: 10,
    });
    const encoded = Buffer.from('café\n');

    try {
      writeFileSync(file, encoded.subarray(0, 4), { flag: 'a' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(lines).toEqual([]);
      writeFileSync(file, encoded.subarray(4), { flag: 'a' });
      await waitFor(() => lines.includes('café'));
      expect(lines).toEqual(['café']);
    } finally {
      tail.close();
    }
  });

  it('resets for a same-or-larger replacement file', async () => {
    writeFileSync(file, 'old\n');
    const snapshot = await readLogSnapshot(file, 100);
    const lines: string[] = [];
    const tail = followLogFile(file, snapshot.size, snapshot.identity, (line) => lines.push(line), {
      pollIntervalMs: 10,
    });
    const replacement = path.join(directory, 'replacement.log');

    try {
      writeFileSync(replacement, 'replacement content is longer than old\n');
      rmSync(file);
      renameSync(replacement, file);
      await waitFor(() => lines.includes('replacement content is longer than old'));
      expect(lines).toEqual(['replacement content is longer than old']);
    } finally {
      tail.close();
    }
  });
});
