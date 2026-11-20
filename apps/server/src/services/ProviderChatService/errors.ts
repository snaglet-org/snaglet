import { isRecord } from '@snaglet/shared/utils';

/**
 * Connection-level failure codes that occur *before any response byte* — the
 * socket is closed/reset or the connect/DNS times out. Always safe to re-send
 * because nothing has streamed yet. `.code` is the undici/Node error code
 * unwrapped from `fetch`'s generic `TypeError`. Shared by the turn-level
 * transient classifier below and provider adapters' own retry loops.
 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_SOCKET', // "other side closed" — server dropped the connection
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN', // transient DNS failure
  // DNS lookup failed outright. A dropped Wi-Fi or VPN reports this rather
  // than EAI_AGAIN on macOS; a typo'd host only costs the short retry window.
  'ENOTFOUND',
]);

const NON_TRANSIENT_MESSAGE_RE =
  /(?:authentication|unauthori[sz]ed|forbidden|invalid[_ ]request|bad request|context (?:length|window)|context overflow|maximum context|prompt (?:is )?too long|too many tokens)/i;
const TRANSIENT_MESSAGE_RE =
  /(?:\bterminated\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))\b|fetch failed|socket (?:closed|hang up)|connection (?:closed|reset|refused)|network error|overloaded(?:_error)?|service unavailable|gateway timeout)/i;

/**
 * Provider adapters with their own pre-content retry loop use this base class
 * for the error that escapes after that loop is exhausted. The turn-level
 * recovery policy must not retry it again and multiply an adapter's attempts.
 */
export class ProviderRetryHandledError extends Error {
  readonly providerRetryHandled = true;
}

export function isProviderRetryHandledError(raw: unknown): boolean {
  return (
    raw instanceof ProviderRetryHandledError || (isRecord(raw) && raw.providerRetryHandled === true)
  );
}

/**
 * Classify provider failures that are safe to resend once at the turn layer.
 * Walks the `cause` chain because undici wraps socket codes under a generic
 * `TypeError: fetch failed` / `TypeError: terminated` error.
 */
export function isTransientProviderError(raw: unknown): boolean {
  const chain = collectErrorChain(raw);
  if (chain.some(isAbortError)) return false;

  const messages = chain.map(readMessage).filter((value) => value.length > 0);
  const combinedMessage = messages.join(' | ');
  const statuses = chain.flatMap(readStatuses);

  // An explicit non-429 4xx wins over generic network wording. Authentication,
  // invalid-request, and context-window failures cannot heal on retry.
  if (statuses.some((status) => status >= 400 && status < 500 && status !== 429)) return false;
  if (NON_TRANSIENT_MESSAGE_RE.test(combinedMessage)) return false;

  if (statuses.some((status) => status === 429 || (status >= 500 && status < 600))) return true;
  if (chain.some((value) => TRANSIENT_NETWORK_CODES.has(readCode(value)))) return true;
  return TRANSIENT_MESSAGE_RE.test(combinedMessage);
}

function collectErrorChain(raw: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = raw;
  while (current != null && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError';
}

function readMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const name = typeof value.name === 'string' ? value.name : '';
  const message = typeof value.message === 'string' ? value.message : '';
  return `${name} ${message}`.trim();
}

function readCode(value: unknown): string {
  if (!isRecord(value)) return '';
  return typeof value.code === 'string' ? value.code.toUpperCase() : '';
}

function readStatuses(value: unknown): number[] {
  const statuses: number[] = [];
  if (isRecord(value)) {
    for (const key of ['status', 'statusCode'] as const) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isInteger(candidate)) statuses.push(candidate);
    }
  }

  const message = readMessage(value);
  const contextualStatusRe =
    /(?:\bhttp(?: status)?|\bstatus(?:code)?|request failed)\s*[=:(-]?\s*(\d{3})\b|\((\d{3})\)/gi;
  for (const match of message.matchAll(contextualStatusRe)) {
    const parsed = Number(match[1] ?? match[2]);
    if (Number.isInteger(parsed)) statuses.push(parsed);
  }
  // Common provider strings omit a status label (for example
  // "OpenAI 503 Service Unavailable"). Restrict the loose match to statuses
  // that could actually be transient so model ids and token counts are ignored.
  for (const match of message.matchAll(/\b(429|5\d{2})\b/g)) {
    statuses.push(Number(match[1]));
  }
  return statuses;
}
