/**
 * workspace_resolve_path — thin probe over `resolveNodeByPath` that returns
 * minimal metadata about the resolved container or doc without loading the
 * doc's content. Useful for existence checks and id lookups.
 *
 * Default behavior (strict=false): returns `{ found: false }` on miss.
 * strict=true: throws on miss.
 *
 * When the `kind` disambiguator is omitted and both a container and a doc
 * share the same path, the underlying `resolveNodeByPath` prefers containers.
 */

import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveNodeByPath } from '@server/services/WorkspaceService/pathResolver';
import { linkForm } from '@server/services/ToolService/lib/linkForm';

interface ResolvePathInputShape {
  path: string;
  kind?: 'doc' | 'container';
  strict?: boolean;
}

function parseInput(input: unknown): ResolvePathInputShape {
  if (!input || typeof input !== 'object') {
    throw new Error('workspace_resolve_path: input must be an object');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.path !== 'string' || i.path.trim().length === 0) {
    throw new Error('workspace_resolve_path: `path` is required and must be a non-empty string');
  }
  if (i.kind !== undefined && i.kind !== 'doc' && i.kind !== 'container') {
    throw new Error('workspace_resolve_path: `kind` must be "doc" or "container" when provided');
  }
  if (i.strict !== undefined && typeof i.strict !== 'boolean') {
    throw new Error('workspace_resolve_path: `strict` must be a boolean when provided');
  }
  return {
    path: i.path.trim(),
    kind: i.kind as 'doc' | 'container' | undefined,
    strict: (i.strict as boolean | undefined) ?? false,
  };
}

const handler: ToolHandler = async (input, _settings, _context) => {
  const params = parseInput(input);

  let resolved: { kind: 'doc' | 'container'; id: string } | null = null;
  try {
    resolved = await resolveNodeByPath(params.path, params.kind);
  } catch (err) {
    // resolveNodeByPath throws on miss. Translate to found:false unless strict.
    if (params.strict) {
      throw err;
    }
    const notFound = { found: false as const, path: params.path };
    return {
      output: JSON.stringify(notFound, null, 2),
      rawContent: notFound,
    };
  }

  // Enrich with display metadata.
  if (resolved.kind === 'container') {
    const c = await Containers.findById(resolved.id);
    if (!c) {
      // Race / inconsistency: resolver said yes, model says no.
      if (params.strict) {
        throw new Error(
          `workspace_resolve_path: container ${resolved.id} disappeared during resolution`
        );
      }
      const out = { found: false as const, path: params.path };
      return { output: JSON.stringify(out, null, 2), rawContent: out };
    }
    const result = {
      found: true as const,
      path: params.path,
      kind: 'container' as const,
      id: c.id,
      name: c.name,
      parent_id: c.parentId,
      sort_order: c.sortOrder,
      link: linkForm('container', c.id, c.name),
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  // resolved.kind === 'doc'
  const d = await Docs.findById(resolved.id);
  if (!d) {
    if (params.strict) {
      throw new Error(`workspace_resolve_path: doc ${resolved.id} disappeared during resolution`);
    }
    const out = { found: false as const, path: params.path };
    return { output: JSON.stringify(out, null, 2), rawContent: out };
  }
  const result = {
    found: true as const,
    path: params.path,
    kind: 'doc' as const,
    id: d.id,
    title: d.title,
    container_id: d.containerId,
    sort_order: d.sortOrder,
    content_length: d.content?.length ?? 0,
    link: linkForm('doc', d.id, d.title),
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
