/**
 * When the reader of the server's stdout goes away (the dev runner exits, a
 * parent is killed), every console write fails with EPIPE. Unguarded, each
 * failure becomes an uncaughtException whose report is another console write,
 * looping until the error log rotates everything else away. A real child
 * process with a closed stdout pipe proves the logger absorbs the failure,
 * stops writing to the console, and keeps logging to file.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_DIR = path.resolve(process.cwd(), 'apps/server');
const LOGGER_URL = pathToFileURL(path.join(SERVER_DIR, 'src/config/logger.ts')).href;

const CHILD_SCRIPT = `
import { writeFileSync } from 'node:fs';
const { logger } = await import(process.env.TEST_LOGGER_URL);
let uncaught = 0;
process.on('uncaughtException', () => { uncaught += 1; });
for (let i = 0; i < 40; i += 1) {
  logger.info('closed-stdout line ' + i);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
await new Promise((resolve) => setTimeout(resolve, 300));
writeFileSync(process.env.TEST_RESULT_PATH, JSON.stringify({ uncaught }));
process.exit(0);
`;

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('logger with a closed stdout', () => {
  it('neither throws nor loops, and keeps logging to file', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'snaglet-closed-stdout-'));
    scratchDirs.push(scratch);
    const logDir = path.join(scratch, 'logs');
    const resultPath = path.join(scratch, 'result.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      SNAGLET_LOG_DIR: logDir,
      TEST_LOGGER_URL: LOGGER_URL,
      TEST_RESULT_PATH: resultPath,
    };
    delete env.SNAGLET_LOG_FILE;

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SCRIPT],
      { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Close the read end before the child writes anything: its stdout is now
    // a pipe with no reader, exactly like an orphaned dev server.
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) });
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as { uncaught: number };
    expect(result.uncaught).toBe(0);

    const log = await readFile(path.join(logDir, 'server.log'), 'utf8');
    expect(log).toContain('[logger] console output disabled after EPIPE');
    expect(log).toContain('closed-stdout line 39');
    expect(log.match(/console output disabled/g)).toHaveLength(1);
  }, 60_000);
});
