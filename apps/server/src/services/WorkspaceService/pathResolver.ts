/**
 * Path Resolver Utility for Workspace Tools
 *
 * Resolves human-readable container paths (e.g., "/Coding/Projects")
 * to container UUIDs, allowing agents to reference containers without
 * looking up IDs first.
 *
 * Path format:
 * - "/" or empty string = root level (returns null)
 * - "/ContainerName" = root-level container
 * - "/Parent/Child" = nested container hierarchy
 *
 * Matching:
 * - Case-insensitive
 * - Exact name match required
 * - Throws if path segment not found or ambiguous (multiple matches)
 */

import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { Nodes } from '@snaglet/db/tables/nodes';

/**
 * Resolve a container path to a container ID.
 *
 * @param path - Path string (e.g., "/Coding/Projects" or "/" for root)
 * @returns Container ID or null for root level
 * @throws Error if path segment not found or ambiguous
 */
export async function resolveContainerByPath(path: string): Promise<string | null> {
  const normalized = path.trim();

  if (!normalized || normalized === '/') {
    return null;
  }

  const segments = normalized
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return null;
  }

  let currentParentId: string | null = null;

  for (let i = 0; i < segments.length; i++) {
    const segmentName = segments[i];
    const isLast = i === segments.length - 1;

    const candidates = await Containers.listByParent(currentParentId);

    const matches = candidates.filter((c) => c.name.toLowerCase() === segmentName.toLowerCase());

    if (matches.length === 0) {
      const pathSoFar = '/' + segments.slice(0, i + 1).join('/');
      throw new Error(
        `Container not found at path: ${pathSoFar} (segment "${segmentName}" has no match)`
      );
    }

    if (matches.length > 1) {
      const pathSoFar = '/' + segments.slice(0, i + 1).join('/');
      const names = matches.map((c) => c.name).join(', ');
      throw new Error(
        `Ambiguous path at: ${pathSoFar} (multiple containers named "${segmentName}": ${names})`
      );
    }

    const container = matches[0];

    if (isLast) {
      return container.id;
    }

    currentParentId = container.id;
  }

  return null;
}

/**
 * Validate and resolve container reference from either container_id or path,
 * with an optional fallback to the calling thread's project when neither
 * is explicitly provided.
 *
 * Resolution precedence:
 *   1. Explicit container_id (validated to exist)
 *   2. Explicit container_path (walked, must resolve)
 *   3. `fallbackThreadId` → the thread's project container (`nodes.project_id`)
 *   4. null (workspace root) — the default for a flat thread
 *
 * The thread fallback exists so agent-created docs/containers land in the
 * project the conversation belongs to by default, instead of always at root.
 * Pass the thread fallback as a separate arg so the tool layer stays in
 * charge of the precedence — handlers that need root-default semantics simply
 * don't pass it.
 *
 * @param containerId - Optional container UUID
 * @param containerPath - Optional container path
 * @param fallbackThreadId - Optional thread id whose project is used when no explicit parent is given
 * @returns Resolved container ID or null for root
 * @throws Error if both id and path provided, or path invalid
 */
export async function resolveContainerReference(
  containerId?: string | null,
  containerPath?: string | null,
  fallbackThreadId?: string | null
): Promise<string | null> {
  const hasId = containerId !== undefined && containerId !== null;
  const hasPath =
    containerPath !== undefined && containerPath !== null && containerPath.trim() !== '';

  if (hasId && hasPath) {
    throw new Error('Cannot specify both container_id and container_path. Use one or the other.');
  }

  if (hasPath) {
    return await resolveContainerByPath(containerPath!);
  }

  if (hasId) {
    const container = await Containers.findById(containerId!);
    if (!container) {
      throw new Error(`Container not found: ${containerId}`);
    }
    return containerId!;
  }

  // No explicit parent — derive one from the calling thread when possible:
  // a project thread writes into its project container; a flat thread (or an
  // unknown id) falls through to the workspace root.
  if (fallbackThreadId) {
    return Nodes.getProjectId(fallbackThreadId);
  }

  return null;
}

/**
 * Resolve a document path to a document ID.
 * Path format: "/container/subcontainer/docTitle"
 * The last segment is the document title.
 *
 * @param path - Full path to document (e.g., "/Projects/Snaglet/overview")
 * @returns Document ID
 * @throws Error if path not found or document doesn't exist
 */
export async function resolveDocByPath(path: string): Promise<string> {
  const normalized = path.trim();

  if (!normalized || normalized === '/') {
    throw new Error('Document path cannot be root. Provide a full path like "/container/docTitle"');
  }

  // Split path into segments
  const segments = normalized
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new Error('Invalid document path: path is empty');
  }

  // Last segment is the document title
  const docTitle = segments[segments.length - 1];
  const containerSegments = segments.slice(0, -1);

  // Resolve container path (null if doc is at root)
  let containerId: string | null = null;
  if (containerSegments.length > 0) {
    const containerPath = '/' + containerSegments.join('/');
    containerId = await resolveContainerByPath(containerPath);
  }

  // Find document with matching title in this container
  const docs = await Docs.listByContainer(containerId);
  const matches = docs.filter((d) => d.title.toLowerCase() === docTitle.toLowerCase());

  if (matches.length === 0) {
    throw new Error(
      `Document not found at path: ${path} (no doc titled "${docTitle}" in container)`
    );
  }

  if (matches.length > 1) {
    const ids = matches.map((d) => d.id).join(', ');
    throw new Error(
      `Ambiguous document path: ${path} (multiple docs titled "${docTitle}": ${ids})`
    );
  }

  return matches[0].id;
}

/**
 * Resolve a workspace path to a node, preferring container if both exist.
 *
 * Returns `{ kind: 'container', id }` if the path matches a container,
 * else `{ kind: 'doc', id }` if it matches a doc. Throws if neither.
 * If `kindHint` is provided, only matches against that kind.
 */
export async function resolveNodeByPath(
  path: string,
  kindHint?: 'doc' | 'container'
): Promise<{ kind: 'doc' | 'container'; id: string }> {
  if (kindHint === 'container') {
    const id = await resolveContainerByPath(path);
    if (!id) throw new Error(`Container not found at path: ${path}`);
    return { kind: 'container', id };
  }
  if (kindHint === 'doc') {
    const id = await resolveDocByPath(path);
    return { kind: 'doc', id };
  }
  // No hint: try container first, fall back to doc
  const containerId = await resolveContainerByPath(path);
  if (containerId) return { kind: 'container', id: containerId };
  try {
    const docId = await resolveDocByPath(path);
    return { kind: 'doc', id: docId };
  } catch (err) {
    throw new Error(
      `No doc or container found at path: ${path} (pass kind='doc' or kind='container' to disambiguate)`
    );
  }
}

/**
 * Resolve a doc target passed as either `doc_id` or `doc_path` (exactly one
 * required) — the shared preamble for docs tools.
 */
export async function resolveDocIdOrThrow(args: {
  doc_id?: string;
  doc_path?: string;
}): Promise<string> {
  if (!args.doc_id && !args.doc_path) throw new Error('Must specify either doc_id or doc_path');
  if (args.doc_id && args.doc_path) throw new Error('Cannot specify both doc_id and doc_path');
  return args.doc_id ?? resolveDocByPath(args.doc_path!);
}
