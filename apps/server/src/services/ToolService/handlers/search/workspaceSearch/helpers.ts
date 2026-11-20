import type { ContainerRow } from '@snaglet/db/tables/containers';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import {
  KIND_TO_LINK_SCHEME,
  type SearchRenderKind,
} from '@server/services/ToolService/lib/workspaceScope';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';

export function fmtLink(kind: SearchRenderKind, id: string, label: string | null): string {
  return linkForm(KIND_TO_LINK_SCHEME[kind], id, label);
}

export function trimToOneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Neutralize-then-trim for untrusted DB content (doc/message/memory/
 * thread-summary bodies) rendered as a one-line preview. Order matters:
 * trimToOneLine's hard character cutoff runs on whatever it's given, so if a
 * forged `<system-reminder>`-shaped tag is padded to straddle that cutoff,
 * trimming before neutralizing leaves a live, unterminated tag fragment in
 * the output (see untrustedContent.ts's module contract). Running
 * neutralizeSystemFraming on the full text first closes the gap: by the time
 * trimToOneLine's slice runs, any forged tag is already `&lt;system-reminder…`,
 * and truncating an already-escaped fragment can never re-expose a live tag
 * shape. Every one-line preview of untrusted content in this tool — whether
 * built inline (memory/thread_summary in formatters.ts) or upstream of
 * renderHit (hydration.ts, resolvers.ts) — must go through this instead of a
 * bare trimToOneLine call.
 */
export function trimUntrustedToOneLine(text: string, max = 140): string {
  return trimToOneLine(neutralizeSystemFraming(text), max);
}

/**
 * Container ancestry helpers over one fetched row set (normally the caller's
 * per-request `containerRowsCache` from `Containers.listAllOrdered()`).
 * `pathOf` renders a container's full ancestry path
 * ("/Grandparent/Parent/Name"); `byId` backs the category lookups at the same
 * call sites. Single shared implementation for the lexical, fuzzy, and
 * semantic-hydration channels.
 */
export function buildContainerPathResolver(rows: ContainerRow[]): {
  byId: Map<string, ContainerRow>;
  pathOf: (id: string) => string;
} {
  const byId = new Map(rows.map((c) => [c.id, c]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.length ? `/${parts.join('/')}` : id;
  };
  return { byId, pathOf };
}
