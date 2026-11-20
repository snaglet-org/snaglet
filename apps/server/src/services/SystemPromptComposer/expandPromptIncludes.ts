/**
 * expandPromptIncludes — swap each doc/thread/container include chip in a
 * system prompt for the referenced node's content before it reaches the LLM
 * (a project drags in as its container chip). Grammar mirrors the chip
 * markdown the client writes (apps/desktop-ui/src/utils/nodeChip/markdown.ts):
 * `![label](doc-<id>)` (preferred), `page-` (alias for doc), `thread-`,
 * `container-`, and the scheme form `page:<uuid>` / `thread:<uuid>` found in
 * older content. Non-recursive, so fan-out stays bounded and include cycles
 * cannot loop.
 */

import { Containers, Docs, Messages, Threads } from '@snaglet/db';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';
import { isAgentRunEndedRow } from '@server/services/SocketService/agentRunEnded';

// Group 1 = (ignored) label text, group 2 = scheme (doc / page / thread /
// container), group 3 = id. Separator is `-` (prefixed-id form) or `:`
// (scheme form). The id is either a UUID or the store's timestamp-slug form
// (`<epoch ms>-<base36 slug>`, e.g. doc-1111111111111-aaaaaaaaa); both
// resolve through `findById(\`<scheme>-<id>\`)` below.
const INCLUDE_RE =
  /!\[([^\]]*)\]\((doc|page|thread|container)[-:]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{10,}-[a-z0-9]+)\)/gi;

// Resolved content sits between `<!-- include -->` / `<!-- /include -->`
// markers, so a body containing `-->` would appear to end the include early
// and put the rest outside the untrusted-include boundary. Escape only that
// closing sequence (`--&gt;`), as neutralizeSystemFraming escapes only the
// reserved shape; content with no `-->` passes through untouched.
function escapeCommentTerminator(text: string): string {
  return text.includes('-->') ? text.split('-->').join('--&gt;') : text;
}

type IncludeMatch = {
  full: string;
  label: string;
  scheme: 'doc' | 'page' | 'thread' | 'container';
  uuid: string;
};

function collectMatches(text: string): IncludeMatch[] {
  const out: IncludeMatch[] = [];
  // `matchAll` with a /g regex is non-mutating on the source string;
  // safe to call without resetting lastIndex.
  for (const m of text.matchAll(INCLUDE_RE)) {
    out.push({
      full: m[0],
      label: m[1] ?? '',
      scheme: m[2].toLowerCase() as IncludeMatch['scheme'],
      uuid: m[3].toLowerCase(),
    });
  }
  return out;
}

async function resolveOne(m: IncludeMatch): Promise<string | null> {
  try {
    switch (m.scheme) {
      case 'doc':
      case 'page': {
        // `page` is an alias for `doc`.
        // The id may be either form (`doc-<uuid>` or bare uuid).
        const doc = await Docs.findById(`doc-${m.uuid}`).catch(() => null);
        if (!doc) return null;
        return doc.content?.trim() ?? null;
      }
      case 'thread': {
        const thread = await Threads.findById(`thread-${m.uuid}`).catch(() => null);
        if (!thread) return null;
        // For threads, the "content" worth including is the message log.
        // Pull a recent slice; threads can be huge so cap to last 20.
        const messages = await Messages.listRecentByThreadId(thread.id, 20).catch(
          () => [] as Awaited<ReturnType<typeof Messages.listRecentByThreadId>>
        );
        if (!messages.length) return null;
        return messages
          .filter((msg) => !isAgentRunEndedRow(msg))
          .map((msg) => {
            const who = msg.role === 'user' ? 'user' : (msg.agentId ?? 'agent');
            return `[${who}]: ${msg.content ?? ''}`;
          })
          .join('\n');
      }
      case 'container': {
        // Containers don't carry their own content — they're folders.
        // Best we can do is surface the name as a labeled placeholder so
        // the LLM at least knows which container was referenced.
        const c = await Containers.findById(`container-${m.uuid}`).catch(() => null);
        if (!c) return null;
        return `(container: ${c.name})`;
      }
      default:
        return null;
    }
  } catch {
    // Fail closed: a broken include should leave the chip in place
    // rather than silently dropping context. We return null and the
    // caller substitutes a `(failed to load …)` marker.
    return null;
  }
}

/**
 * Expand every include chip in `text`. Returns the rewritten string.
 * Chips with no resolvable target are replaced with a short marker so
 * the user can see in agent logs that the include was attempted and
 * failed; chips with a target are replaced with a fenced block.
 */
export async function expandPromptIncludes(text: string): Promise<string> {
  if (!text || !text.includes('![')) return text;
  const matches = collectMatches(text);
  if (matches.length === 0) return text;

  // De-dupe by (scheme, uuid) — fetch each referenced node once even
  // if the same chip appears multiple times in the prompt.
  const uniq = new Map<string, IncludeMatch>();
  for (const m of matches) {
    uniq.set(`${m.scheme}:${m.uuid}`, m);
  }
  const resolved = new Map<string, string | null>();
  await Promise.all(
    [...uniq.entries()].map(async ([key, m]) => {
      resolved.set(key, await resolveOne(m));
    })
  );

  let out = text;
  for (const m of matches) {
    const key = `${m.scheme}:${m.uuid}`;
    const content = resolved.get(key);
    const label = m.label.trim() || `${m.scheme}:${m.uuid.slice(0, 8)}`;
    // Resolved doc/thread bodies are untrusted: neutralize forged platform
    // framing (`<system-reminder>`) and escape `-->` so a body cannot break out
    // of the include markers. Neutralize only, with no notice prefix:
    // identityBlock reuses this for the agent's own system prompt, whose
    // cached output must stay byte-stable. Clean content passes unchanged.
    const safeContent =
      content !== null && content !== undefined
        ? escapeCommentTerminator(neutralizeSystemFraming(content))
        : content;
    const replacement =
      safeContent === null || safeContent === undefined
        ? `<!-- include: ${label} (${m.scheme}-${m.uuid}) — not found or empty -->`
        : `<!-- include: ${label} (${m.scheme}-${m.uuid}) -->\n${safeContent}\n<!-- /include -->`;
    // Replace first occurrence; matches are in document order so this
    // walks left-to-right correctly even with repeated chips.
    out = out.replace(m.full, replacement);
  }
  return out;
}
