import type { ToolHandler } from '@server/services/ToolService/types';
import { neutralizeThenTruncate } from '@server/services/ToolService/lib/untrustedContent';

// Fetched pages are fully untrusted, attacker-reachable text — any site an
// agent is told to fetch can embed a literal `<system-reminder>`-shaped tag
// hoping the model mistakes it for a genuine platform directive (a
// prompt-injection surface). It uses the shared neutralize implementation and
// its neutralize-before-truncate ordering (see the module contract in
// untrustedContent.ts): truncating first would let a forged
// `<system-reminder` tag padded to straddle the cutoff lose its closing `>`
// and reach the model un-escaped. The outside-content notice is added where
// the result enters an agent's context.

const MAX_BODY_CHARS = 50_000;

const tool: ToolHandler = async (input) => {
  const url = String(input.url ?? '');
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!url) throw new Error('url is required');

  const headers = (input.headers ?? {}) as Record<string, string>;
  const body = input.body ? String(input.body) : undefined;

  const res = await fetch(url, {
    method,
    headers,
    body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
  });

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const safeBody = neutralizeThenTruncate(text, MAX_BODY_CHARS);

  return `HTTP ${res.status} ${res.statusText}\nContent-Type: ${contentType}\n\n${safeBody}`;
};

export default tool;
