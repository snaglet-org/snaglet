import { getDb } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { KIND_GLYPH } from '@server/services/ToolService/lib/workspaceScope';
import { formatRelativeTime } from '@snaglet/shared/utils';
import { fmtLink, trimToOneLine, trimUntrustedToOneLine } from './helpers';
import { buildThreadEnrichment, renderHit } from './formatters';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';
import type { ContainerHit, DetailLevel, MessageHit, ThreadHit, ThreadSummaryHit } from './types';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';

//
// Cheap gate before the DB round-trip — single token of word chars or
// hyphens, length 2+. Prose queries with spaces or punctuation skip the
// lookup entirely. Single bare words ("auth", "search") still pass this
// gate and incur one extra SELECT, which returns no rows and falls
// through; the cost is negligible vs. the agent's full search wall.
const LOOKS_LIKE_ID_RE = /^[A-Za-z0-9_-]{2,}$/;

export function looksLikeSearchId(query: string): boolean {
  return LOOKS_LIKE_ID_RE.test(query);
}

/**
 * Try to resolve `query` as a literal node id. Returns the rendered output
 * on success, or null to fall through to text search.
 *
 * Resolution path:
 *   1. SELECT type FROM public.nodes WHERE id = $1
 *   2. Dispatch to a per-kind fetch+render. Each renderer does one
 *      additional SELECT against the kind's domain table joined to nodes
 *      for updated_at, and emits a result block in the same shape the
 *      main renderer uses (`<glyph> [<label>](<id>) · <when> …`).
 *
 * Kinds rendered: doc, thread, container, message,
 * agent, memory, thread_summary, tool, image, file.
 * Kinds with a generic fallback line: block — agents rarely address these
 * by id and the existing renderer doesn't cover them, so we acknowledge the
 * type and stop.
 */
async function tryResolveById(
  query: string,
  detail: DetailLevel = 'compact',
  memoryScope: MemorySearchScope | null = null
): Promise<string | null> {
  const pool = getDb();
  const { rows } = await pool.query<{ type: string }>(
    'SELECT type FROM public.nodes WHERE id = $1',
    [query]
  );
  if (rows.length === 0) return null;
  const type = rows[0].type;
  switch (type) {
    case 'doc':
      return renderResolvedDoc(query, detail);
    case 'thread':
      return renderResolvedThread(query);
    // Projects are containers (containers.category='project'); a project id
    // resolves as type='container', so the 'project' node type older callers
    // still send routes to the container renderer.
    case 'project':
    case 'container':
      return renderResolvedContainer(query);
    case 'message':
      return renderResolvedMessage(query);
    case 'memory':
      // Out of scope reads exactly like a missing node: never confirm it exists.
      return renderResolvedMemory(query, memoryScope);
    case 'thread_summary':
      return renderResolvedThreadSummary(query);
    case 'tool':
      return renderResolvedTool(query);
    case 'image':
      return renderResolvedImage(query);
    case 'file':
      return renderResolvedFile(query);
    default:
      return `Resolved id "${query}" → ${type} (no detail renderer for this kind yet).`;
  }
}

/**
 * `memoryScope` is whose memories the caller may read (memoryScope.ts); a
 * memory id outside it, or with no scope, answers "No node found".
 */
export async function renderResolvedIds(
  ids: string[],
  detail: DetailLevel,
  memoryScope: MemorySearchScope | null = null
): Promise<string> {
  const blocks = await Promise.all(
    ids.map(
      async (id) =>
        (await tryResolveById(id, detail, memoryScope)) ?? `No node found for id "${id}".`
    )
  );
  if (blocks.length === 1) return blocks[0];
  return `${blocks.length} id lookup(s):\n\n${blocks.join('\n\n')}`;
}

function resolutionHeader(id: string, kind: string): string {
  return `Resolved id "${id}" → ${kind}\n`;
}

async function renderResolvedDoc(id: string, detail: DetailLevel): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    title: string;
    updated_at: string;
    content: string | null;
  }>(
    `SELECT d.id, d.title, n.updated_at, d.content
       FROM public.docs d
       JOIN public.nodes n ON n.id = d.id
      WHERE d.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → doc, but the doc row is missing.`;
  const link = fmtLink('doc', row.id, row.title || '(untitled doc)');
  const updated = formatRelativeTime(row.updated_at);
  if (detail === 'full') {
    // This resolver bypasses renderHit entirely (unlike the main search-hit
    // doc path in formatters.ts), so it must neutralize the body itself. The
    // full body is the entire raw doc content, unbounded; no truncation
    // applies here, so there is no ordering hazard.
    return `${resolutionHeader(id, 'doc')}\n${KIND_GLYPH.doc} ${link} · ${updated}\n\nContent:\n\n${neutralizeSystemFraming(row.content ?? '')}`;
  }
  // Compact path truncates to one line: trimUntrustedToOneLine (see
  // helpers.ts) neutralizes before it truncates.
  const snippet = trimUntrustedToOneLine(row.content ?? '', 200) || '(empty doc)';
  return `${resolutionHeader(id, 'doc')}\n${KIND_GLYPH.doc} ${link} · ${updated}\n  ${snippet}`;
}

async function renderResolvedThread(id: string): Promise<string> {
  const { rows } = await getDb().query<{ id: string; title: string | null; updated_at: string }>(
    `SELECT t.id, t.title, COALESCE(t.last_message_at, n.updated_at) AS updated_at
       FROM public.threads t
       JOIN public.nodes n ON n.id = t.id
      WHERE t.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → thread, but the thread row is missing.`;
  const hit: ThreadHit = {
    kind: 'thread',
    id: row.id,
    title: row.title ?? '(untitled thread)',
    updatedAt: row.updated_at,
  };
  const enrichment = await buildThreadEnrichment([row.id]);
  return `${resolutionHeader(id, 'thread')}\n${renderHit(hit, enrichment)}`;
}

async function renderResolvedContainer(id: string): Promise<string> {
  const { rows } = await getDb().query<{ id: string; name: string; updated_at: string }>(
    `SELECT c.id, c.name, n.updated_at
       FROM public.containers c
       JOIN public.nodes n ON n.id = c.id
      WHERE c.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → container, but the container row is missing.`;
  // Reuse the same path-walking logic the main flow uses so the path
  // string is consistent across both lookup modes.
  const containerRows = await Containers.listAllOrdered();
  const byId = new Map(containerRows.map((c) => [c.id, c]));
  const parts: string[] = [];
  let cur = byId.get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const path = parts.length ? `/${parts.join('/')}` : id;
  const hit: ContainerHit = {
    kind: 'container',
    id: row.id,
    name: row.name,
    category: byId.get(id)?.category ?? null,
    updatedAt: row.updated_at,
    path,
  };
  return `${resolutionHeader(id, 'container')}\n${renderHit(hit, new Map())}`;
}

async function renderResolvedMessage(id: string): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    thread_id: string;
    thread_title: string;
    role: string;
    agent_name: string | null;
    user_name: string | null;
    user_id: number | null;
    agent_id: string | null;
    content: string | null;
    created_at: string;
  }>(
    `SELECT m.id,
            m.thread_id,
            COALESCE(t.title, '(untitled thread)') AS thread_title,
            m.role,
            m.agent_id,
            a.name AS agent_name,
            m.user_id,
            u.name AS user_name,
            m.created_at,
            m.content
       FROM public.messages m
       JOIN public.nodes n ON n.id = m.id
       JOIN public.threads t ON t.id = m.thread_id
       LEFT JOIN public.agents a ON a.id = m.agent_id
       LEFT JOIN public.users u ON u.id = m.user_id
      WHERE m.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → message, but the message row is missing.`;
  const sender =
    row.agent_name ??
    row.user_name ??
    (row.role === 'user' ? (row.user_id == null ? 'user' : `user ${row.user_id}`) : null) ??
    row.agent_id ??
    row.role;
  const hit: MessageHit = {
    kind: 'message',
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    sender,
    sentAt: row.created_at,
    updatedAt: row.created_at,
    // Neutralize before truncating (see helpers.ts): unlike the doc/memory
    // resolvers, this one reaches renderHit (below), which neutralizes the
    // snippet again — but only after this trim, so the trim itself must not
    // run on raw, un-neutralized content.
    snippet: trimUntrustedToOneLine(row.content ?? '', 200),
  };
  return `${resolutionHeader(id, 'message')}\n${renderHit(hit, new Map())}`;
}

async function renderResolvedMemory(
  id: string,
  memoryScope: MemorySearchScope | null
): Promise<string | null> {
  const { rows } = await getDb().query<{
    id: string;
    agent_id: string | null;
    memory_key: string | null;
    content: string | null;
    updated_at: string;
  }>(
    `SELECT m.id, m.agent_id, m.memory_key, m.content, n.updated_at
       FROM public.memories m
       JOIN public.nodes n ON n.id = m.id
      WHERE m.id = $1
        AND ${memoryScopeSql('m', 2, 3)}`,
    [id, ...memoryScopeParams(memoryScope)]
  );
  const row = rows[0];
  if (!row) return null;
  const updated = formatRelativeTime(row.updated_at);
  const link = linkForm('memory', row.id, row.memory_key || 'Memory');
  const owner = row.agent_id ? `\n  Owner: ${row.agent_id}` : '';
  // Same bypass as renderResolvedDoc above: this resolver never calls
  // renderHit, so it needs its own neutralize-before-truncate call
  // (trimUntrustedToOneLine).
  const snippet = trimUntrustedToOneLine(row.content ?? '', 200) || '(empty)';
  return `${resolutionHeader(id, 'memory')}\n🧠 ${link} · ${updated}${owner}\n  ${snippet}`;
}

async function renderResolvedThreadSummary(id: string): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    thread_id: string;
    thread_title: string;
    agent_id: string | null;
    summary_text: string | null;
    updated_at: string;
  }>(
    `SELECT ts.id,
            ts.thread_id,
            COALESCE(t.title, '(untitled thread)') AS thread_title,
            ts.agent_id,
            ts.summary_text,
            n.updated_at
       FROM public.thread_summaries ts
       JOIN public.nodes n ON n.id = ts.id
       JOIN public.threads t ON t.id = ts.thread_id
      WHERE ts.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) {
    return `Resolved id "${id}" → thread_summary, but the thread summary row is missing.`;
  }
  const hit: ThreadSummaryHit = {
    kind: 'thread_summary',
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    agentId: row.agent_id,
    summaryText: row.summary_text,
    updatedAt: row.updated_at,
  };
  return `${resolutionHeader(id, 'thread_summary')}\n${renderHit(hit, new Map())}`;
}

async function renderResolvedTool(id: string): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    name: string;
    description: string | null;
    category_path: string;
    tier: string;
    enabled: boolean;
  }>(`SELECT id, name, description, category_path, tier, enabled FROM public.tools WHERE id = $1`, [
    id,
  ]);
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → tool, but the tool row is missing.`;
  // `tool` isn't in LinkNodeType (linkForm rejects it), so build the
  // markdown link manually using the `tool:` scheme the desktop content
  // parser recognizes (see nodeRef.ts).
  const safeName = (row.name || row.id).replace(/[\]\\]/g, '\\$&');
  const link = `[${safeName}](tool:${row.id})`;
  const lines = [
    `${resolutionHeader(id, 'tool')}`,
    `🔧 ${link} · ${row.tier} · ${row.category_path} · ${row.enabled ? 'enabled' : 'disabled'}`,
  ];
  if (row.description) lines.push(`  ${trimToOneLine(row.description, 200)}`);
  return lines.join('\n');
}

async function renderResolvedImage(id: string): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    alt_text: string | null;
    description: string | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    container_id: string | null;
    updated_at: string;
  }>(
    `SELECT i.id, i.alt_text, i.description, i.tags, i.metadata,
            n.container_id, n.updated_at
       FROM public.images i
       JOIN public.nodes n ON n.id = i.id
      WHERE i.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → image, but the image row is missing.`;
  const meta = row.metadata ?? {};
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream';
  const sizeBytes = typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0;
  const sizeKb = (sizeBytes / 1024).toFixed(1);
  const tags = (row.tags ?? []).length > 0 ? ` · tags: ${(row.tags ?? []).join(', ')}` : '';
  // Same shape as the tool renderer — inline the markdown link
  // because `image` isn't in LinkNodeType, and the `image-` prefix is
  // self-identifying at content-ref parse time.
  const safeName = (row.alt_text || 'Untitled image').replace(/[\]\\]/g, '\\$&');
  const link = `[${safeName}](${row.id})`;
  const lines = [
    `${resolutionHeader(id, 'image')}`,
    `🖼️ ${link} · ${mimeType} · ${sizeKb} KB${tags}`,
  ];
  if (row.container_id) lines.push(`  Container: \`${row.container_id}\``);
  // Same bypass as renderResolvedDoc/renderResolvedMemory above: this
  // resolver never calls renderHit, and image.description is agent-writable
  // via the always-enabled image_update_metadata tool with no write-time
  // sanitization, so it needs its own neutralize-before-truncate call
  // instead of a bare trimToOneLine.
  if (row.description) lines.push(`  ${trimUntrustedToOneLine(row.description, 200)}`);
  lines.push(
    `  Use \`file\` (op:read, mode:image) with \`id\` set to this id to attach the bytes for vision.`
  );
  return lines.join('\n');
}

async function renderResolvedFile(id: string): Promise<string> {
  const { rows } = await getDb().query<{
    id: string;
    relative_path: string;
    project_id: string;
    size_bytes: string | number;
    updated_at: string;
  }>(
    `SELECT f.id, f.relative_path, f.project_id, f.size_bytes, n.updated_at
       FROM public.files f
       JOIN public.nodes n ON n.id = f.id
      WHERE f.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → file, but the file row is missing.`;
  const updated = formatRelativeTime(row.updated_at);
  // `file` isn't a LinkNodeType; the `file-` prefix is self-identifying.
  const safe = row.relative_path.replace(/[\]\\]/g, '\\$&');
  const link = `[${safe}](${row.id})`;
  const sizeKb = (Number(row.size_bytes) / 1024).toFixed(1);
  return [
    `${resolutionHeader(id, 'file')}`,
    `📎 ${link} · ${updated} · ${sizeKb} KB · project ${row.project_id}`,
  ].join('\n');
}
