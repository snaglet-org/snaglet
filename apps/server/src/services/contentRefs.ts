/**
 * Shared helpers for extracting and syncing node content references: markdown
 * links to another node inside a text body (doc markdown, etc.). Two grammars:
 *   1. Scheme form `[Title](page:<uuid>)`, still present in older content; the
 *      scheme carries the node type and the id is a bare UUID.
 *   2. Prefixed-id form `[Title](<nodeType>-<id>)`, e.g. `[Foo](doc-…)`; the id
 *      carries its type and matches `public.nodes.id`.
 * Both produce `references` edges in `public.links`. Callers: the workspace/doc
 * routes and the workspace agent tools.
 */

import { LINK_LABEL_SOURCE, splitDocRef, TOOL_ID_SOURCE } from '@snaglet/shared/utils';
import { Links } from '@snaglet/db/tables/links';
import { logger } from '@server/config/logger';

/**
 * Scheme names accepted in older content. The matched id is a bare UUID;
 * `page` and `task` are both aliases for `doc`.
 */
const LEGACY_NODE_LINK_TYPES = ['page', 'thread', 'task'] as const;

/**
 * Node id prefixes. Longer prefixes (`thread_summary`) must come before
 * shorter ones (`thread`) so the alternation doesn't short-match. Three are
 * not `public.node_type` values but still appear in content: `task-…` ids
 * (real `public.nodes` rows of kind `doc`), `agent-…` chips (agents are actors in the agents
 * table; the link/actor layer decides what resolves), and `sketch-…` ids,
 * which resolve to an unresolved item.
 */
const NODE_TYPE_PREFIXES = [
  'thread_summary',
  'container',
  'message',
  'memory',
  'thread',
  'sketch',
  'agent',
  'image',
  'task',
  'tool',
  'post',
  'doc',
] as const;

const UUID_RE_SOURCE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * Scheme form `[Title](<scheme>:<uuid>)`. Capture groups:
 *   [1] = display title, [2] = scheme, [3] = uuid
 */
const LEGACY_NODE_LINK_RE = new RegExp(
  `\\[([^\\]]+)\\]\\((${LEGACY_NODE_LINK_TYPES.join('|')}):(${UUID_RE_SOURCE})\\)`,
  'g'
);

/**
 * Prefixed-id `[Title](<nodeType>-<rest>)`. The matched id is the entire
 * `<nodeType>-<rest>` string (the value of `public.nodes.id`).
 * Capture groups: [1] = display title, [2] = full prefixed id.
 */
const PREFIXED_NODE_LINK_RE = new RegExp(
  `\\[([^\\]]+)\\]\\(((?:${NODE_TYPE_PREFIXES.join('|')})-[^)\\s]+)\\)`,
  'g'
);

/**
 * Named-scheme `[Title](tool:<bareName>)`. Tool ids are author-chosen handles,
 * not UUIDs and not hyphen-prefixed, so
 * neither the scheme-form UUID regex nor the prefixed-id regex
 * catches them. The matched id is the bare name, which is also the
 * value of `public.nodes.id` for the row.
 *
 * Capture groups: [1] = display title, [2] = scheme, [3] = bare id.
 */
const NAMED_SCHEME_NODE_LINK_RE = new RegExp(
  `\\[([^\\]]+)\\]\\((tool):(${TOOL_ID_SOURCE})\\)`,
  'g'
);

/**
 * `![](<doc-target>)`: a transclusion. The config resolver splices the doc's
 * full content into a prompt at runtime. Canonical form has no title (it would go
 * stale on rename); a title in the brackets is captured but ignored.
 * Accepts `page:<uuid>` (older content) and `doc-<id>`. Capture groups:
 *   [1] = optional title (ignored)
 *   [2] = `page:` uuid (mutually exclusive with [3])
 *   [3] = prefixed `doc-…` id (mutually exclusive with [2])
 */
export const TRANSCLUSION_RE = new RegExp(
  `!\\[(${LINK_LABEL_SOURCE})\\]\\((?:page:(${UUID_RE_SOURCE})|(doc-[^)\\s]+))\\)`,
  'g'
);

/**
 * Bare-id grammar — a prefixed id in raw text with no `[](...)` wrapper,
 * equivalent to the markdown link form. `!doc-…` is the transclusion
 * shortcut, like `![](doc-…)`. The lookbehind keeps the regex from grabbing an
 * id-shaped suffix of a longer token (`foo-doc-abc`); the trailing class stops
 * at the first non-id character.
 *
 * Capture groups: [1] = optional `!`, [2] = full prefixed id.
 */
export const BARE_NODE_REF_RE = new RegExp(
  `(?<![A-Za-z0-9_\\-])(!?)((?:${NODE_TYPE_PREFIXES.join('|')})-[A-Za-z0-9_][A-Za-z0-9_\\-]*)`,
  'g'
);

/**
 * Fire-and-forget background link operation. Swallows errors after logging
 * so a link-sync failure can never fail the caller's request — these
 * writes are always derived from a primary write the user already cared
 * about.
 */
function linkOp(fn: () => Promise<unknown>): void {
  fn().catch((err) => logger.error('[link sync] failed:', err));
}

/**
 * Extract node refs from a content body and sync them to the `links`
 * table as `references` edges outgoing from the given source node.
 *
 * Replaces all outgoing `references` links from this source on every call,
 * so deleting a ref from content removes its row.
 */
export function syncContentRefLinks(sourceId: string, content: string | null): void {
  const targetIds: string[] = [];
  if (content) {
    const seen = new Set<string>();
    const harvest = (re: RegExp, idGroup: number) => {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        // `doc-…#L12-L20` / `doc-…#h=slug` link part of a doc; the backlink targets the doc.
        const targetId = match[idGroup] ? splitDocRef(match[idGroup]).id : match[idGroup];
        if (!targetId || targetId === sourceId || seen.has(targetId)) continue;
        seen.add(targetId);
        targetIds.push(targetId);
      }
    };
    harvest(LEGACY_NODE_LINK_RE, 3);
    harvest(PREFIXED_NODE_LINK_RE, 2);
    // Named-scheme tool refs — `[Title](tool:bareName)`; the two regexes
    // above miss them.
    harvest(NAMED_SCHEME_NODE_LINK_RE, 3);
    // Bare-id grammar — picks up both raw `doc-…` references and the
    // `!doc-…` transclusion shortcut. The `seen` set dedups the ids
    // that already came in via the markdown-link forms above.
    harvest(BARE_NODE_REF_RE, 2);
  }
  linkOp(() => Links.replaceOutgoing(sourceId, 'references', targetIds));
}
