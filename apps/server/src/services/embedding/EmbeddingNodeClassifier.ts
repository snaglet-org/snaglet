import { getDb } from '@snaglet/db/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { Docs } from '@snaglet/db/tables/docs';
import { Projects } from '@snaglet/db/tables/projects';
import { Containers } from '@snaglet/db/tables/containers';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { helperThreadExclusionSql } from '@snaglet/db/tables/threads';
import { Files } from '@snaglet/db/tables/files';
import { Images } from '@snaglet/db/tables/images';
import { expandPromptIncludes } from '@server/services/SystemPromptComposer/expandPromptIncludes';
import { FileEmbeddings } from '@snaglet/db/tables/files';
import {
  embeddingContentHash,
  estimateEmbeddingTokens,
  normalizeEmbeddingContent,
} from './contentHash';
import { readEmbeddableFileContent, resolveWithinFolder } from './fileSource';
import { isEmbeddableMessage, EMBEDDABLE_MESSAGE_SQL } from './messageEligibility';
import { isHiddenThread } from '@server/services/subagents/helperVisibility';

export type EmbeddingNodeType =
  | 'container'
  | 'doc'
  | 'memory'
  | 'message'
  | 'thread_summary'
  | 'file'
  | 'image';

export const BACKFILL_EMBEDDING_NODE_TYPES: readonly EmbeddingNodeType[] = [
  'container',
  'doc',
  'memory',
  'message',
  'thread_summary',
  'file',
  'image',
];

export function isEmbeddingNodeType(value: string): value is EmbeddingNodeType {
  return (BACKFILL_EMBEDDING_NODE_TYPES as readonly string[]).includes(value);
}

export interface EmbeddingTarget {
  nodeType: EmbeddingNodeType;
  nodeId: string;
  content: string;
  contentHash: string;
  estimatedTokens: number;
  /** Source version captured while composing content; guards slow writes. */
  sourceUpdatedAt?: string;
}

type EmbeddingTargetState = 'missing' | 'stale' | 'fresh' | 'empty';

export interface ClassifiedEmbeddingTarget extends EmbeddingTarget {
  state: EmbeddingTargetState;
}

function joinBlob(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => normalizeEmbeddingContent(p))
    .filter((p) => p.length > 0)
    .join('\n\n');
}

function toTarget(
  nodeType: EmbeddingNodeType,
  nodeId: string,
  content: string,
  sourceUpdatedAt?: string
): EmbeddingTarget | null {
  const normalized = normalizeEmbeddingContent(content);
  if (!nodeId || !normalized) return null;
  return {
    nodeType,
    nodeId,
    content: normalized,
    contentHash: embeddingContentHash(normalized),
    estimatedTokens: estimateEmbeddingTokens(normalized),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

export async function buildEmbeddingTarget(
  nodeType: EmbeddingNodeType,
  nodeId: string
): Promise<EmbeddingTarget | null> {
  if (nodeType === 'container') {
    const container = await Containers.findById(nodeId);
    if (!container) return null;
    // A project container's description is retrieval signal — embed name +
    // expanded description (parity with the pre-rework project-node embedding).
    // Plain containers embed just their name. Inline `![](doc-…)` includes in
    // the description are expanded so what retrieval indexes matches what an
    // agent reads at thread start (see buildProjectLineageString).
    if (container.category === 'project') {
      const project = await Projects.findById(nodeId);
      const description = project?.description
        ? await expandPromptIncludes(project.description)
        : '';
      return toTarget(nodeType, nodeId, joinBlob([container.name, description]));
    }
    return toTarget(nodeType, nodeId, container.name);
  }
  if (nodeType === 'doc') {
    const doc = await Docs.findById(nodeId);
    return doc ? toTarget(nodeType, nodeId, joinBlob([doc.title, doc.content])) : null;
  }
  if (nodeType === 'memory') {
    const memory = await Memories.findById(nodeId);
    return memory ? toTarget(nodeType, nodeId, memory.content) : null;
  }
  if (nodeType === 'message') {
    const message = await Messages.findById(nodeId);
    return message && isEmbeddableMessage(message) && !(await isHiddenThread(message.threadId))
      ? toTarget(nodeType, nodeId, message.content)
      : null;
  }
  if (nodeType === 'image') {
    // No pixels in the vector — an image is searchable via the human-authored
    // description + tags (and its name/alt-text). Agents set these via the
    // image_update_metadata tool; changing them re-embeds (content hash).
    const image = await Images.findMetaById(nodeId);
    if (!image) return null;
    if (!image.description?.trim() && image.tags.length === 0) return null;
    return toTarget(
      nodeType,
      nodeId,
      joinBlob([image.name, image.description, image.tags.join(', ')]),
      image.updatedAt
    );
  }
  if (nodeType === 'file') {
    // File bodies live on disk, not in Postgres. Resolve project.folder_path +
    // relative_path and read the body only — no path header. File embeddings
    // are content-addressed (file_embeddings, keyed by the on-disk-bytes
    // sha256 that ingest writes to files.content_hash), so the embedded text
    // must be identical for every path/project referencing the same bytes.
    // Location is surfaced at read time by joining files on content_hash, and
    // a rename is free (same bytes → same key → zero compute). Extractable
    // files (PDF) embed their derived text layer under the raw-bytes key —
    // extraction is deterministic, so the invariant holds.
    //
    // Must return null — never throw — on any failure: a thrown error here
    // aborts the entire listEmbeddingTargets loop and halts embedding for every
    // other file.
    try {
      const file = await Files.findById(nodeId);
      if (!file) return null;
      const project = await Projects.findById(file.projectId);
      if (!project?.folderPath) return null;
      const abs = resolveWithinFolder(project.folderPath, file.relativePath);
      if (!abs) return null;
      const read = await readEmbeddableFileContent(abs);
      if (read.status !== 'ok') return null;
      const normalized = normalizeEmbeddingContent(read.content);
      if (!normalized) return null;
      return {
        nodeType,
        nodeId,
        content: normalized,
        // On-disk-bytes hash (not the normalized-content hash) so the key
        // always matches what ingest stamped on the files row.
        contentHash: read.contentHash,
        estimatedTokens: estimateEmbeddingTokens(normalized),
      };
    } catch {
      return null;
    }
  }
  const summary = await ThreadSummaries.findById(nodeId);
  return summary && !(await isHiddenThread(summary.threadId))
    ? toTarget(nodeType, nodeId, summary.summaryText)
    : null;
}

async function listNodeIdsForType(nodeType: EmbeddingNodeType): Promise<string[]> {
  const db = getDb();
  let sql: string;
  switch (nodeType) {
    case 'container':
      sql = `SELECT c.id FROM containers c JOIN nodes n ON n.id = c.id
             WHERE c.name IS NOT NULL AND TRIM(c.name) <> ''
             ORDER BY n.updated_at ASC`;
      break;
    case 'doc':
      sql = `SELECT d.id FROM docs d JOIN nodes n ON n.id = d.id
             WHERE (d.title IS NOT NULL AND TRIM(d.title) <> '')
                OR (d.content IS NOT NULL AND TRIM(d.content) <> '')
             ORDER BY n.updated_at ASC`;
      break;
    case 'memory':
      sql = `SELECT m.id FROM memories m JOIN nodes n ON n.id = m.id
             WHERE m.content IS NOT NULL AND TRIM(m.content) <> ''
             ORDER BY n.updated_at ASC`;
      break;
    case 'message':
      // Shared eligibility excludes thread events and every injected row.
      sql = `SELECT m.id FROM messages m JOIN nodes n ON n.id = m.id
             WHERE m.content IS NOT NULL AND TRIM(m.content) <> ''
               AND ${EMBEDDABLE_MESSAGE_SQL}
             ORDER BY n.created_at ASC`;
      break;
    case 'thread_summary':
      sql = `SELECT ts.id FROM thread_summaries ts JOIN nodes n ON n.id = ts.id
             WHERE ts.summary_text IS NOT NULL AND TRIM(ts.summary_text) <> ''
               AND ${helperThreadExclusionSql('ts.thread_id')}
             ORDER BY n.updated_at ASC`;
      break;
    case 'file':
      // No content column — file bodies live on disk. Enumerate all file nodes;
      // buildEmbeddingTarget() reads each body and skips (returns null) any that
      // are missing, oversized, or binary.
      sql = `SELECT f.id FROM files f JOIN nodes n ON n.id = f.id
             ORDER BY n.updated_at ASC`;
      break;
    case 'image':
      // Only images with human-authored description or tags are embeddable —
      // the pixels aren't indexed. Skip bare images with no searchable text.
      sql = `SELECT i.id FROM images i JOIN nodes n ON n.id = i.id
             WHERE (i.description IS NOT NULL AND TRIM(i.description) <> '')
                OR COALESCE(array_length(i.tags, 1), 0) > 0
             ORDER BY n.updated_at ASC`;
      break;
  }
  const { rows } = await db.query<{ id: string }>(sql);
  return rows.map((row) => row.id).filter(Boolean);
}

export async function listEmbeddingTargets(
  nodeTypes: readonly EmbeddingNodeType[]
): Promise<EmbeddingTarget[]> {
  const targets: EmbeddingTarget[] = [];
  for (const nodeType of nodeTypes) {
    const ids = await listNodeIdsForType(nodeType);
    for (const id of ids) {
      const target = await buildEmbeddingTarget(nodeType, id);
      if (target) targets.push(target);
    }
  }
  return targets;
}

export async function classifyEmbeddingTarget(
  target: EmbeddingTarget,
  modelId: string
): Promise<ClassifiedEmbeddingTarget> {
  if (!target.content) return { ...target, state: 'empty' };
  // Files are content-addressed: the (content_hash, model) pair either exists
  // or it doesn't. Changed content is a NEW hash, i.e. 'missing' — there is no
  // per-node 'stale' state to refresh.
  if (target.nodeType === 'file') {
    const exists = await FileEmbeddings.existsByHashModel(target.contentHash, modelId);
    return { ...target, state: exists ? 'fresh' : 'missing' };
  }
  const rows = await Embeddings.listByNode(target.nodeId, modelId);
  if (rows.length === 0) return { ...target, state: 'missing' };
  return {
    ...target,
    state: rows.some((row) => row.contentHash === target.contentHash) ? 'fresh' : 'stale',
  };
}

export async function classifyEmbeddingTargets(
  targets: readonly EmbeddingTarget[],
  modelId: string
): Promise<ClassifiedEmbeddingTarget[]> {
  const classified: ClassifiedEmbeddingTarget[] = [];
  for (const target of targets) {
    classified.push(await classifyEmbeddingTarget(target, modelId));
  }
  return classified;
}
