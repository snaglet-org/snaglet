// Must stay the first import: the log directory and level below are resolved
// while this module is evaluated, so the env files have to be loaded already.
import { environmentLoadMessages } from './environment';
import winston from 'winston';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { getErrorMessage } from '@snaglet/shared/utils';
import { expandHomePath } from '@snaglet/shared/utils/paths';

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const VALID_LEVELS = new Set(Object.keys(levels));
const envLevel = (process.env.LOG_LEVEL ?? '').toLowerCase();
const resolvedLevel = VALID_LEVELS.has(envLevel) ? envLevel : 'info';

// Colors for console output
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

// --- Secret redaction -------------------------------------------------------
// Mask credential-shaped substrings before anything is written to console or
// disk. This is a defense-in-depth net, not a license to log secrets: it
// catches API keys, bearer tokens, and the sidecar token query param that ride
// along in message strings (e.g. WS connection URLs, error dumps).
const REDACTION_RULES: Array<{ pattern: RegExp; replace: string }> = [
  // Anthropic / OpenAI style keys: sk-ant-..., sk-...
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: 'sk-ant-***REDACTED***' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: 'sk-***REDACTED***' },
  // Authorization: Bearer <token>
  { pattern: /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, replace: '$1***REDACTED***' },
  // Sidecar token on query strings or headers: snaglet_token=... / x-snaglet-token: ...
  {
    pattern: /(snaglet[_-]?token["'\s]*[=:]\s*["']?)[A-Za-z0-9._-]{6,}/gi,
    replace: '$1***REDACTED***',
  },
  // Snaglet MCP API-key tokens (mcpAuth's `snaglet_mcp_` + an 8-hex home tag
  // and `_` + hex secret; the tag is masked too, and so is a malformed token
  // without one). The prefix is
  // deliberately greppable/identifiable (see mcpAuth.ts), so keep it visible
  // and mask only the secret body — none of the rules above match this shape
  // (it contains no "token"/"Bearer"/"sk-"), so without this a leaked MCP key
  // riding along in a message string would print raw.
  { pattern: /(snaglet_mcp_)(?:[0-9a-fA-F]{8}_)?[0-9a-fA-F]{16,}/g, replace: '$1***REDACTED***' },
];

export function redactSecrets(value: unknown): string {
  let str = typeof value === 'string' ? value : String(value ?? '');
  for (const { pattern, replace } of REDACTION_RULES) {
    str = str.replace(pattern, replace);
  }
  return str;
}

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redactSecrets(info.message);
  }
  if (typeof info.stack === 'string') {
    info.stack = redactSecrets(info.stack);
  }
  return info;
})();

// --- Structured meta ----------------------------------------------------------
// `logger.info('msg', { id })` merges `id` into the info object; the line
// formats below print it after the message so meta is never silently dropped.

/** Info keys the line layout already renders (symbol keys are never listed). */
const RENDERED_INFO_KEYS = new Set(['level', 'message', 'timestamp', 'stack']);

/** Bound a single line: meta objects are not size-checked by their callers. */
const MAX_META_CHARS = 4_000;

function metaReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      const code = (value as NodeJS.ErrnoException).code;
      return { name: value.name, message: value.message, ...(code ? { code } : {}) };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * The info object's own fields beyond the rendered ones, as ` {json}` (or ''
 * when there are none). Redacted and length-capped; never throws.
 */
export function formatMetaTail(info: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(info).filter(
    ([key, value]) => !RENDERED_INFO_KEYS.has(key) && value !== undefined
  );
  if (entries.length === 0) return '';
  let json: string;
  try {
    json = JSON.stringify(Object.fromEntries(entries), metaReplacer());
  } catch (err: unknown) {
    json = `[unserializable meta: ${getErrorMessage(err)}]`;
  }
  if (json.length > MAX_META_CHARS) {
    json = `${json.slice(0, MAX_META_CHARS)}…(+${json.length - MAX_META_CHARS} chars)`;
  }
  return ` ${redactSecrets(json)}`;
}

const ESC = String.fromCharCode(27);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

function renderLine(info: winston.Logform.TransformableInfo, metaStyle?: (s: string) => string) {
  const meta = formatMetaTail(info);
  const stack = info.stack ? `\n${info.stack}` : '';
  return `${info.timestamp} [${info.level}]: ${info.message}${meta && metaStyle ? metaStyle(meta) : meta}${stack}`;
}

// Format for console (colorized, human-readable)
const consoleFormat = winston.format.combine(
  redactFormat,
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ level: true }),
  winston.format.printf((info) => renderLine(info, (meta) => `${DIM}${meta}${RESET}`))
);

// File format: structured, de-ANSI'd, timestamped — human-readable for tailing.
// ANSI is stripped from the finished line, so colored message text, error
// blocks carried in `stack`, and meta all land clean.
const fileFormat = winston.format.combine(
  redactFormat,
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => renderLine(info).replace(ANSI_SGR, ''))
);

// Log directory: <SNAGLET_HOME>/logs (created if missing). Overridable via
// SNAGLET_LOG_DIR. Do not derive Snaglet-owned state from HOME: the desktop shell must
// preserve the real OS home for user-facing filesystem path expansion.
// Values are `~`-expanded (dotenv delivers `SNAGLET_HOME=~/.snaglet` literally) but not
// strictly validated here — the logger must never take down boot; the snagletHome
// service and packages/db resolvers reject relative values with a clear error.
const configuredLogDir = process.env.SNAGLET_LOG_DIR?.trim();
const configuredHome = process.env.SNAGLET_HOME?.trim();
const logDir = configuredLogDir
  ? expandHomePath(configuredLogDir)
  : path.join(
      configuredHome ? expandHomePath(configuredHome) : path.join(os.homedir(), '.snaglet'),
      'logs'
    );

/** Directory used by this process's file transports. */
export const logDirectory = logDir;

// File logging is on by default. Set SNAGLET_LOG_FILE=false to go console-only —
// useful for ephemeral/sandboxed runs (CI, tests, throwaway worktrees) that
// shouldn't spray files into ~/.snaglet/logs. Any other value keeps it on.
// Single source of truth so the mkdir gate and buildFileTransports can't drift.
// Read at call time so runtime env toggles (e.g. tests) are honored.
function isFileLoggingEnabled(): boolean {
  return process.env.SNAGLET_LOG_FILE !== 'false';
}

if (isFileLoggingEnabled()) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort; if this fails the console transport still works
  }
}

/**
 * The files the transports below keep open. Clearing logs in Settings →
 * Storage truncates these in place instead of deleting them (snagletHome.ts).
 */
export const SERVER_LOG_FILE = 'server.log';
export const SERVER_ERROR_LOG_FILE = 'server.error.log';

/**
 * Rotating on-disk transports (server.log + server.error.log, 20MB x5).
 * Returns an empty list when SNAGLET_LOG_FILE=false so the logger is console-only.
 * Exported so the transport-toggle can be unit-tested without importing the
 * live singleton (which would open handles under ~/.snaglet).
 */
export function buildFileTransports(dir: string): winston.transport[] {
  if (!isFileLoggingEnabled()) return [];
  return [
    // Full clean log — everything at the active level, rotated at 20MB x5.
    new winston.transports.File({
      filename: path.join(dir, SERVER_LOG_FILE),
      format: fileFormat,
      maxsize: 20 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    // Errors-only log — so failures are greppable without wading through info noise.
    new winston.transports.File({
      filename: path.join(dir, SERVER_ERROR_LOG_FILE),
      level: 'error',
      format: fileFormat,
      maxsize: 20 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ];
}

// --- Closed console streams -------------------------------------------------
// winston's Console transport writes straight to process.stdout, bypassing the
// global console's error swallowing. Once the pipe's reader is gone (the dev
// runner exited, a parent was killed) every write fails with EPIPE, and Node
// resets process.stdout instead of destroying it, so each write fails again.
// With no 'error' listener each failure is an uncaughtException whose report
// is itself a console write — a self-sustaining loop that fills the error log
// and rotates older logs away. The guard makes the first failure silence the
// console transport for good; file transports keep recording.

const STREAM_GUARD = Symbol.for('snaglet.logger.consoleStreamGuard');

type GuardableStream = NodeJS.EventEmitter & {
  [STREAM_GUARD]?: Set<(err: NodeJS.ErrnoException) => void>;
};

/**
 * Route 'error' events on the given streams to `onError` instead of letting
 * them throw. One listener per stream no matter how many module instances
 * install it (test registries, re-evaluation), keyed by a global symbol.
 */
export function guardConsoleStreams(
  streams: readonly GuardableStream[],
  onError: (err: NodeJS.ErrnoException) => void
): void {
  for (const stream of streams) {
    let handlers = stream[STREAM_GUARD];
    if (!handlers) {
      const installed = new Set<(err: NodeJS.ErrnoException) => void>();
      stream.on('error', (err: NodeJS.ErrnoException) => {
        for (const handler of installed) handler(err);
      });
      stream[STREAM_GUARD] = installed;
      handlers = installed;
    }
    handlers.add(onError);
  }
}

const consoleTransport = new winston.transports.Console({ format: consoleFormat });

// Create logger — console (terminal) + rotating file (so logs survive without a terminal).
// Level defaults to 'info'; set LOG_LEVEL=debug for verbose diagnostics.
export const logger = winston.createLogger({
  level: resolvedLevel,
  levels,
  transports: [consoleTransport, ...buildFileTransports(logDir)],
  exitOnError: false,
});

guardConsoleStreams([process.stdout, process.stderr], (err) => {
  if (consoleTransport.silent) return;
  consoleTransport.silent = true;
  logger.warn(
    `[logger] console output disabled after ${err.code ?? getErrorMessage(err)} on stdout/stderr; ` +
      'file logging continues'
  );
});

for (const { level, text } of environmentLoadMessages.splice(0)) {
  logger.log(level, text);
}

// Stream for morgan HTTP logging
export const httpLogStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};
