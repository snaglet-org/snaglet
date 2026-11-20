import type { ToolHandler } from '@server/services/ToolService/types';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';
import { getErrorMessage } from '@snaglet/shared/utils';

const DEFAULT_RESULTS = 5;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;

/** Cap on the whole request (headers + body) so a hung provider can't stall a run. */
const REQUEST_TIMEOUT_MS = 15_000;

const SEARCH_MCP_HINT = 'Use a connected search MCP such as Firecrawl instead.';

// DuckDuckGo answers suspected automation with an "anomaly" challenge page in
// place of results (served as HTTP 202 today). Checking the markers too means a
// challenge served as 200 is never misread as an empty result.
const CHALLENGE_MARKERS = [
  'anomaly-modal',
  'anomaly.js',
  'bots use duckduckgo too',
  'confirm this search was made by a human',
];

function isChallengePage(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * `num` per the schema (integer, default 5, 1..10). The alias `max_results`
 * name is still read. Anything non-numeric falls back to the default; numbers
 * are floored and clamped into the schema's bounds.
 */
function resultLimit(input: Record<string, unknown>): number {
  const raw = input.num ?? input.max_results;
  const requested = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.floor(requested)));
}

/** The low-level reason Node's fetch gives for a network failure (e.g. `ENOTFOUND`). */
function networkErrorReason(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    if (cause instanceof Error && cause.message) return cause.message;
  }
  return getErrorMessage(err);
}

/**
 * Fetch the results page, bounded by REQUEST_TIMEOUT_MS and the run's own
 * abort signal. Every failure to get a response becomes a plain, named error
 * instead of a raw fetch exception.
 */
async function fetchResultsPage(
  url: string,
  runSignal: AbortSignal | undefined
): Promise<{ status: number; html: string }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Snaglet-Agent/1.0' },
      signal,
    });
    return { status: res.status, html: await res.text() };
  } catch (err) {
    if (runSignal?.aborted) {
      throw new Error('Web search was canceled because the run was stopped.');
    }
    if (timeout.aborted) {
      throw new Error(
        `Web search timed out after ${REQUEST_TIMEOUT_MS / 1000} s waiting for the search provider. ${SEARCH_MCP_HINT}`
      );
    }
    throw new Error(
      `Web search failed: could not reach the search provider (${networkErrorReason(err)}). Check the network connection. ${SEARCH_MCP_HINT}`
    );
  }
}

const tool: ToolHandler = async (input, _settings, context) => {
  const query = String(input.query ?? '');
  if (!query) throw new Error('query is required');
  const maxResults = resultLimit(input);

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, html } = await fetchResultsPage(url, context?.signal);

  const results: string[] = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { url: string; title: string }[] = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].replace(/&amp;/g, '&');
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    links.push({ url: href, title });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(
      match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        // Do not decode &lt;/&gt; back into literal < / > here. A page can
        // (innocently or otherwise) contain an HTML-escaped tag-shaped string
        // in its snippet text — e.g. a blog post's own escaped example of
        // `<system-reminder>`. Decoding those entities back into live angle
        // brackets RECONSTRUCTS a forged platform-framing tag out of text
        // that arrived safely inert — actively worse than doing nothing.
        // Leave entities as entities; the untrustedContent util below is the
        // one place that decides what (if anything) needs escaping.
        .trim()
    );
  }

  // Only a 200 carries a results page (`res.ok` admits any 2xx). The challenge
  // markers count only when nothing parsed, since a real result snippet may
  // quote the challenge text.
  const challenged = isChallengePage(html);
  if (status !== 200 || (links.length === 0 && challenged)) {
    throw new Error(
      challenged
        ? `Web search was blocked by the search provider (bot challenge, HTTP ${status}). ${SEARCH_MCP_HINT}`
        : `Web search failed: the search provider returned HTTP ${status} instead of results. ${SEARCH_MCP_HINT}`
    );
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const snippet = snippets[i] ? `\n  ${snippets[i]}` : '';
    results.push(`${i + 1}. ${links[i].title}\n  ${links[i].url}${snippet}`);
  }

  if (results.length === 0) return `No results found for: ${query}`;
  // Search-result pages are fully untrusted, attacker-reachable content
  // (same threat model as web_fetch). Neutralize any
  // forged `<system-reminder>`-shaped tag that reaches the rendered output —
  // whether via a field the tag-strip regexes above don't scrub (e.g. the
  // href, captured verbatim) or by some other path. The outside-content
  // notice is added where the result enters an agent's context.
  return neutralizeSystemFraming(results.join('\n\n'));
};

export default tool;
