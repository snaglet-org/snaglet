/**
 * Log secret-redaction — defense-in-depth masking applied to every log line
 * before it reaches the console or disk. Locks in that the sidecar session
 * token (and other credential-shaped substrings) never appear raw in a log.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import winston from 'winston';
import {
  redactSecrets,
  buildFileTransports,
  formatMetaTail,
  guardConsoleStreams,
} from '@server/config/logger';

describe('redactSecrets', () => {
  test('masks the sidecar token on a query string (WS connection URL)', () => {
    const raw = 'WS connect ws://127.0.0.1:51234/ws?snaglet_token=s3cr3t-Abc_123.def';
    const out = redactSecrets(raw);
    expect(out).not.toContain('s3cr3t-Abc_123.def');
    expect(out).toContain('snaglet_token=***REDACTED***');
  });

  test('masks the sidecar token on a header dump (x-snaglet-token: ...)', () => {
    const raw = 'request headers: x-snaglet-token: s3cr3t-Abc_123.def';
    const out = redactSecrets(raw);
    expect(out).not.toContain('s3cr3t-Abc_123.def');
    expect(out).toContain('***REDACTED***');
  });

  test('masks an Authorization: Bearer token', () => {
    const raw = 'Authorization: Bearer abcDEF123456._-token';
    const out = redactSecrets(raw);
    expect(out).not.toContain('abcDEF123456._-token');
    expect(out).toContain('Bearer ***REDACTED***');
  });

  test('masks Anthropic/OpenAI style API keys', () => {
    expect(redactSecrets('key sk-ant-abcdefgh12345678')).toContain('sk-ant-***REDACTED***');
    expect(redactSecrets('key sk-abcdefgh12345678abcdefgh')).toContain('sk-***REDACTED***');
  });

  test('masks a Snaglet MCP API-key token but keeps its identifiable prefix', () => {
    const token = `snaglet_mcp_${'a1b2c3d4'.repeat(6)}`; // snaglet_mcp_ + 48 hex chars
    const out = redactSecrets(`[mcp-auth] rejected key ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('snaglet_mcp_***REDACTED***');
  });

  test('masks a home-tagged MCP key (snaglet_mcp_<8 hex>_<48 hex>), tag included', () => {
    const token = `snaglet_mcp_0a1b2c3d_${'a1b2c3d4'.repeat(6)}`;
    const out = redactSecrets(`[mcp-auth] rejected key ${token}`);
    expect(out).not.toContain(token);
    expect(out).not.toContain('0a1b2c3d');
    expect(out).toContain('snaglet_mcp_***REDACTED***');
  });

  test.each([
    ['an Authorization header', (t: string) => `request headers: Authorization: Bearer ${t}`],
    ['a ?key= URL', (t: string) => `GET http://127.0.0.1:4001/mcp?key=${t}&x=1`],
    ['a JSON body', (t: string) => `{"key":"${t}"}`],
  ])('masks a home-tagged MCP key in %s', (_label, line) => {
    const token = `snaglet_mcp_0a1b2c3d_${'a1b2c3d4'.repeat(6)}`;
    const out = redactSecrets(line(token));
    expect(out).not.toContain(token);
    expect(out).not.toContain('a1b2c3d4a1b2c3d4');
    expect(out).not.toContain('0a1b2c3d');
    expect(out).toMatch(/\*\*\*REDACTED\*\*\*/);
  });

  test('leaves ordinary log lines untouched', () => {
    const raw = 'server listening on 127.0.0.1:51234';
    expect(redactSecrets(raw)).toBe(raw);
  });

  test('coerces non-string input without throwing', () => {
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(42)).toBe('42');
  });
});

/**
 * SNAGLET_LOG_FILE toggle — the two rotating file transports must be present by
 * default and skipped entirely when SNAGLET_LOG_FILE=false (console-only). The
 * transports are pointed at a throwaway tmp dir, never ~/.snaglet.
 */
describe('buildFileTransports (SNAGLET_LOG_FILE toggle)', () => {
  const prev = process.env.SNAGLET_LOG_FILE;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaglet-logtest-'));

  afterEach(() => {
    if (prev === undefined) delete process.env.SNAGLET_LOG_FILE;
    else process.env.SNAGLET_LOG_FILE = prev;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('builds both rotating file transports by default', () => {
    delete process.env.SNAGLET_LOG_FILE;
    expect(buildFileTransports(tmpDir)).toHaveLength(2);
  });

  test('omits both file transports when SNAGLET_LOG_FILE=false', () => {
    process.env.SNAGLET_LOG_FILE = 'false';
    expect(buildFileTransports(tmpDir)).toHaveLength(0);
  });

  test('any value other than "false" keeps file logging on', () => {
    process.env.SNAGLET_LOG_FILE = 'true';
    expect(buildFileTransports(tmpDir)).toHaveLength(2);
  });
});

describe('formatMetaTail', () => {
  test('renders the fields beyond the line layout as JSON', () => {
    expect(
      formatMetaTail({
        level: 'info',
        message: 'snapshot taken',
        timestamp: '2026-01-01 00:00:00',
        stack: 'Error: x',
        id: 'snapshot-1',
        count: 2,
        skipped: undefined,
      })
    ).toBe(' {"id":"snapshot-1","count":2}');
  });

  test('is empty when there is nothing beyond the layout', () => {
    expect(formatMetaTail({ level: 'info', message: 'plain line' })).toBe('');
  });

  test('redacts credential-shaped values', () => {
    const tail = formatMetaTail({ header: 'Authorization: Bearer abcDEF123456._-token' });
    expect(tail).not.toContain('abcDEF123456._-token');
    expect(tail).toContain('Bearer ***REDACTED***');
  });

  test('survives circular, bigint, and Error values', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const tail = formatMetaTail({ circular, big: BigInt(7), failure });
    expect(tail).toContain('"self":"[Circular]"');
    expect(tail).toContain('"big":"7"');
    expect(tail).toContain('"failure":{"name":"Error","message":"write EPIPE","code":"EPIPE"}');
  });

  test('caps an oversized meta object', () => {
    const tail = formatMetaTail({ blob: 'x'.repeat(10_000) });
    expect(tail.length).toBeLessThan(4_100);
    expect(tail).toMatch(/…\(\+\d+ chars\)$/);
  });
});

describe('file log line format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaglet-logformat-'));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function readLogUntil(file: string, expected: string): Promise<string> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (text.includes(expected) || Date.now() > deadline) return text;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test('writes meta after the message, the stack below it, and no ANSI', async () => {
    const prev = process.env.SNAGLET_LOG_FILE;
    delete process.env.SNAGLET_LOG_FILE;
    const transports = buildFileTransports(tmpDir);
    if (prev !== undefined) process.env.SNAGLET_LOG_FILE = prev;
    const fileLogger = winston.createLogger({ level: 'info', transports });
    const esc = String.fromCharCode(27);

    fileLogger.info('Pre-migration snapshot taken', { id: 'snapshot-1' });
    fileLogger.error(`${esc}[34m[chat]${esc}[0m failed`, {
      provider: 'test-provider',
      stack: `  ${esc}[38;5;208mError: boom${esc}[0m\n    at test`,
    });

    const text = await readLogUntil(path.join(tmpDir, 'server.log'), 'at test');
    fileLogger.close();

    expect(text).toMatch(/\[info\]: Pre-migration snapshot taken \{"id":"snapshot-1"\}\n/);
    expect(text).toMatch(
      /\[error\]: \[chat\] failed \{"provider":"test-provider"\}\n {2}Error: boom\n {4}at test/
    );
    expect(text).not.toContain(esc);
  });
});

/**
 * A closed stdout must neither throw nor loop: the guard turns the stream's
 * 'error' event into a callback (the logger silences its console transport).
 */
describe('guardConsoleStreams', () => {
  const epipe = (): NodeJS.ErrnoException =>
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });

  test('an unguarded stream error throws (the failure the guard exists for)', () => {
    expect(() => new EventEmitter().emit('error', epipe())).toThrow('write EPIPE');
  });

  test('routes stream errors to the handler instead of throwing', () => {
    const stream = new EventEmitter();
    const seen: string[] = [];
    guardConsoleStreams([stream], (err) => seen.push(err.code ?? 'none'));

    expect(() => stream.emit('error', epipe())).not.toThrow();
    expect(() => stream.emit('error', epipe())).not.toThrow();
    expect(seen).toEqual(['EPIPE', 'EPIPE']);
  });

  test('installs one listener per stream however many times it is guarded', () => {
    const stream = new EventEmitter();
    const first = jest.fn();
    const second = jest.fn();
    guardConsoleStreams([stream], first);
    guardConsoleStreams([stream], second);

    expect(stream.listenerCount('error')).toBe(1);
    stream.emit('error', epipe());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
