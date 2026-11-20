/**
 * LogsService — Structured, context-aware logging layer.
 *
 * Wraps the Winston logger from config/logger with:
 * - Consistent structured event schema
 * - Automatic context propagation via AsyncLocalStorage
 * - Domain-specific helpers (chat, tool, agent, socket)
 *
 * Usage:
 *   LogsService.info('chat:message:send', { threadId, tokens: 156 });
 *   LogsService.error('tool:execution:failed', error, { toolName });
 *
 *   // Inject context for an entire async operation:
 *   LogsService.withContext({ threadId, agentId }, async () => { ... });
 */

import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../config/logger';
import { logsContent } from './logContent';

export interface LogContext {
  requestId?: string;
  userId?: string;
  agentId?: string;
  agentName?: string;
  threadId?: string;
  threadName?: string;
  modelName?: string;
  runId?: string;
  toolName?: string;
  service?: string;
}

type LogMeta = Record<string, unknown>;

const storage = new AsyncLocalStorage<LogContext>();

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  // foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  orange: '\x1b[38;5;208m',
};

/** Color map for domain tags */
const domainColor: Record<string, string> = {
  server: c.gray,
  ws: c.cyan,
  chat: c.blue,
  agent: c.magenta,
  tool: c.yellow,
  http: c.dim,
  user: c.orange,
  // tool sub-actions
  'tool call': c.yellow,
  'tool result': c.green,
  'tool confirm': c.cyan,
  'tool error': c.red,
  thinking: `${c.dim}${c.italic}`,
};

function tag(label: string, color?: string): string {
  const clr = color ?? domainColor[label] ?? c.white;
  return `${clr}[${label}]${c.reset}`;
}

/** Resolve agent name, thread label, and model name from meta + context */
function resolveIdentifiers(meta?: LogMeta, context?: LogContext) {
  const agentName = (meta?.agentName as string) ?? context?.agentName ?? context?.agentId ?? '-';
  const threadLabel =
    (meta?.threadName as string) ??
    context?.threadName ??
    (meta?.threadId as string) ??
    context?.threadId ??
    '-';
  const modelName = (meta?.modelName as string) ?? context?.modelName ?? null;
  return { agentName, threadLabel, modelName };
}

/**
 * Builds the console message string following the pattern:
 *   [<domain>][<agentName>][thread: <threadName>] <message>
 */
function formatMessage(
  domain: string,
  message: string,
  meta?: LogMeta,
  context?: LogContext
): string {
  const { agentName, threadLabel, modelName } = resolveIdentifiers(meta, context);
  const modelTag = modelName ? `${c.dim}[${modelName}]${c.reset}` : '';
  return (
    `${tag(domain)}` +
    `${c.bold}[${agentName}]${c.reset}` +
    `${c.dim}[thread: ${threadLabel}]${c.reset}` +
    `${modelTag} ` +
    message
  );
}

/** Meta fields that carry conversation content; dropped unless logsContent(). */
const CONTENT_META_KEYS = new Set([
  'text',
  'content',
  'preview',
  'thinking',
  'input',
  'output',
  'prompt',
  'reply',
]);

/** A failed tool's reason, kept short: it explains the failure without the payload. */
const MAX_TOOL_ERROR_CHARS = 160;

/**
 * Builds the tool line:
 *   [ws][<agentName>][thread: <threadName>][tool call][<toolName>]
 *   [ws][<agentName>][thread: <threadName>][tool result][<toolName>] ok 25ms
 * A failed result adds a short reason. With SNAGLET_LOG_CONTENT=1 the call adds
 * `input: <params>` and the result its output.
 */
function formatToolMessage(action: string, meta?: LogMeta, context?: LogContext): string {
  const { agentName, threadLabel, modelName } = resolveIdentifiers(meta, context);
  const toolName = (meta?.toolName as string) ?? context?.toolName ?? '-';
  const modelTag = modelName ? `${c.dim}[${modelName}]${c.reset}` : '';
  const msg =
    `${tag('ws')}` +
    `${c.bold}[${agentName}]${c.reset}` +
    `${c.dim}[thread: ${threadLabel}]${c.reset}` +
    `${modelTag}` +
    `${tag(action)}` +
    `${domainColor[action] ?? c.white}[${toolName}]${c.reset}`;
  if (meta?.input != null) {
    return logsContent() ? `${msg} input: ${c.dim}${meta.input}${c.reset}` : msg;
  }
  if (action === 'tool result' || action === 'tool error') {
    const success = meta?.success === true;
    const statusColor = success ? c.green : c.red;
    const status = `${statusColor}${success ? 'ok' : 'fail'}${c.reset}`;
    const duration = meta?.durationMs != null ? ` ${c.dim}${meta.durationMs}ms${c.reset}` : '';
    const output = logsContent() && meta?.output != null ? ` ${c.dim}${meta.output}${c.reset}` : '';
    const reason =
      !success && typeof meta?.error === 'string' && !logsContent()
        ? ` ${c.dim}${meta.error.slice(0, MAX_TOOL_ERROR_CHARS)}${c.reset}`
        : '';
    return `${msg} ${status}${duration}${output}${reason}`;
  }
  return msg;
}

const MAX_NON_ERROR_CHARS = 1_000;

/** A thrown non-Error (a provider's error payload, say) rendered as its content, not `[object Object]`. */
function describeNonError(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json.length > MAX_NON_ERROR_CHARS ? `${json.slice(0, MAX_NON_ERROR_CHARS)}…` : json;
    }
  } catch {
    // Circular or otherwise unserializable — fall through to String().
  }
  return String(value);
}

/** The error block printed under a log line (the logger renders it from `stack`). */
function formatError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : describeNonError(error);
  const stack = error instanceof Error && error.stack ? `\n${c.dim}${error.stack}${c.reset}` : '';
  return `  ${c.red}${name}: ${message}${c.reset}${stack}`;
}

/** Keys already rendered in the [domain][agent][thread: …] prefix. */
const RENDERED_META_KEYS = new Set(['agentName', 'threadName', 'threadId', 'modelName']);

/** Keys winston itself owns on a log entry; a caller's field by that name is renamed, not lost. */
const LOGGER_OWNED_KEYS = new Set(['level', 'message', 'stack', 'timestamp']);

/**
 * Winston meta for one line: the caller's fields that the prefix does not
 * already show (the logger prints them after the message), plus the error
 * block carried as `stack` so it renders beneath the line.
 */
function lineMeta(meta?: LogMeta, error?: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const keepContent = logsContent();
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (RENDERED_META_KEYS.has(key)) continue;
    if (!keepContent && CONTENT_META_KEYS.has(key)) continue;
    fields[LOGGER_OWNED_KEYS.has(key) ? `meta.${key}` : key] = value;
  }
  if (error) fields.stack = formatError(error);
  return fields;
}

function logStructured(
  level: 'info' | 'warn' | 'debug' | 'http' | 'error',
  domain: string,
  message: string,
  meta?: LogMeta,
  error?: unknown
): void {
  const context = storage.getStore();
  logger[level](formatMessage(domain, message, meta, context), lineMeta(meta, error));
}

export const LogsService = {
  /**
   * Run fn with context merged into all logs inside the async operation.
   * Nested withContext calls merge on top of the parent context.
   */
  withContext<T>(context: LogContext, fn: () => T): T {
    const parent = storage.getStore() ?? {};
    return storage.run({ ...parent, ...context }, fn);
  },

  /** Returns the currently active log context, if any. */
  getContext(): LogContext | undefined {
    return storage.getStore();
  },

  info(message: string, meta?: LogMeta): void {
    logStructured('info', 'server', message, meta);
  },

  warn(message: string, meta?: LogMeta): void {
    logStructured('warn', 'server', message, meta);
  },

  debug(message: string, meta?: LogMeta): void {
    logStructured('debug', 'server', message, meta);
  },

  http(message: string, meta?: LogMeta): void {
    logStructured('http', 'server', message, meta);
  },

  error(message: string, error: unknown, meta?: LogMeta): void {
    logStructured('error', 'server', message, meta, error);
  },

  // --- Domain helpers ---

  user: {
    message: (meta?: LogMeta) => {
      const context = storage.getStore();
      const { threadLabel, modelName } = resolveIdentifiers(meta, context);
      const userName = (meta?.userName as string) ?? 'user';
      const text = logsContent() && meta?.text != null ? ` ${meta.text}` : '';
      const modelTag = modelName ? `${c.dim}[${modelName}]${c.reset}` : '';
      const msg =
        `${tag('ws')}` +
        `${c.orange}${c.bold}[${userName}]${c.reset}` +
        `${c.dim}[thread: ${threadLabel}]${c.reset}` +
        `${modelTag}` +
        `${c.orange} message${c.reset}` +
        `${c.dim}${text}${c.reset}`;
      logger.info(msg);
    },
  },

  chat: {
    send: (meta?: LogMeta) => logStructured('info', 'chat', 'message sent', meta),
    receive: (meta?: LogMeta) => logStructured('info', 'chat', 'message received', meta),
    stream: (meta?: LogMeta) => logStructured('debug', 'chat', 'stream chunk', meta),
    abort: (meta?: LogMeta) => logStructured('info', 'chat', 'stream aborted', meta),
    error: (error: unknown, meta?: LogMeta) => logStructured('error', 'chat', 'error', meta, error),
  },

  tool: {
    start: (meta?: LogMeta) => {
      const context = storage.getStore();
      logger.info(formatToolMessage('tool call', meta, context));
    },
    end: (meta?: LogMeta) => {
      const context = storage.getStore();
      logger.info(formatToolMessage('tool result', meta, context));
    },
    confirm: (meta?: LogMeta) => {
      const context = storage.getStore();
      logger.info(formatToolMessage('tool confirm', meta, context));
    },
    error: (error: unknown, meta?: LogMeta) => {
      const context = storage.getStore();
      // The tool line already renders its fields, so only the error block rides along.
      logger.error(
        formatToolMessage('tool error', meta, context),
        error ? { stack: formatError(error) } : {}
      );
    },
  },

  thinking: {
    start: (meta?: LogMeta) => logStructured('debug', 'thinking', 'started', meta),
    end: (meta?: LogMeta) => logStructured('debug', 'thinking', 'complete', meta),
  },

  agent: {
    start: (meta?: LogMeta) => logStructured('info', 'agent', 'run started', meta),
    end: (meta?: LogMeta) => logStructured('info', 'agent', 'run complete', meta),
    memory: (meta?: LogMeta) => logStructured('debug', 'agent', 'memory updated', meta),
    error: (error: unknown, meta?: LogMeta) =>
      logStructured('error', 'agent', 'error', meta, error),
  },

  socket: {
    connect: (meta?: LogMeta) => logStructured('info', 'ws', 'client connected', meta),
    disconnect: (meta?: LogMeta) => logStructured('info', 'ws', 'client disconnected', meta),
    event: (message: string, meta?: LogMeta) => logStructured('info', 'ws', message, meta),
    error: (error: unknown, meta?: LogMeta) => logStructured('error', 'ws', 'error', meta, error),
  },

  request: {
    start: (meta?: LogMeta) => logStructured('http', 'http', 'request started', meta),
    end: (meta?: LogMeta) => logStructured('http', 'http', 'request complete', meta),
    error: (error: unknown, meta?: LogMeta) =>
      logStructured('error', 'http', 'request error', meta, error),
  },
};
