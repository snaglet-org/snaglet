/**
 * serializers — row shape in, file bytes out.
 *
 * Pure functions over plain row-shaped input: no database, no filesystem, no
 * actor resolution. The service layer loads rows and decides where bytes go;
 * everything about *format* lives here and is testable on its own.
 *
 * Every markdown artifact carries YAML frontmatter. It costs nothing when
 * unused and it is the entire basis of any future re-import or per-tool
 * adapter — an archive that is not self-describing cannot be adapted later.
 */

import { withFrontmatter, type Frontmatter } from './frontmatter';
import { defuseTranscriptBody } from './transcript';
import { safeFilenameWithExtension, safeFilename } from './safeFilename';

/** Common provenance stamped on every export. `exportedBy` is resolved from
 *  the ambient actor by the service — never from request input. */
export interface ExportProvenance {
  exportedAt: string;
  exportedBy: string;
  snagletVersion: string;
}

function provenance(p: ExportProvenance): Frontmatter {
  return {
    exported_at: p.exportedAt,
    exported_by: p.exportedBy,
    snaglet_version: p.snagletVersion,
    timestamps: 'UTC',
  };
}

// Doc

export interface DocExportInput {
  id: string;
  title: string;
  content: string;
  /** The container id. Snaglet has no container-path builder, so the header states
   *  the id it actually knows rather than a path it would have to invent. */
  containerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Docs are already markdown — the body is emitted verbatim. */
export function serializeDoc(doc: DocExportInput, p: ExportProvenance): string {
  return withFrontmatter(
    {
      snaglet_kind: 'doc',
      id: doc.id,
      title: doc.title,
      container_id: doc.containerId,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      ...provenance(p),
    },
    doc.content
  );
}

export function docFilename(doc: Pick<DocExportInput, 'title'>): string {
  return safeFilenameWithExtension(doc.title, '.md', 'untitled-doc');
}

// Memory

export interface MemoryExportInput {
  id: string;
  key: string | null;
  content: string;
  agentName: string | null;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeMemory(memory: MemoryExportInput, p: ExportProvenance): string {
  return withFrontmatter(
    {
      snaglet_kind: 'memory',
      id: memory.id,
      key: memory.key,
      agent: memory.agentName,
      source_thread: memory.sourceThreadId,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
      ...provenance(p),
    },
    memory.content
  );
}

/** `memory_key` is nullable in the schema; the id is the fallback. */
export function memoryFilename(memory: Pick<MemoryExportInput, 'key' | 'id'>): string {
  return safeFilenameWithExtension(memory.key?.trim() || memory.id, '.md', memory.id);
}

/**
 * All of one agent's memories as a single document.
 *
 * One file rather than a folder: "everything this agent knows" is the actual
 * use, and a single memory is a paragraph. Each entry gets a heading and its
 * own metadata line, and bodies are defused — memory content is model-authored
 * and would otherwise be able to forge the entry headings around it.
 */
export function serializeAgentMemories(
  agentName: string,
  agentId: string,
  memories: readonly MemoryExportInput[],
  p: ExportProvenance
): string {
  const body = memories.length
    ? memories
        .map((memory) => {
          const heading = `## ${defuseTranscriptBody(memory.key?.trim() || memory.id)}`;
          const meta = [
            `\`${memory.id}\``,
            memory.sourceThreadId ? `from thread \`${memory.sourceThreadId}\`` : null,
            memory.createdAt,
          ]
            .filter(Boolean)
            .join(' · ');
          return `${heading}\n\n_${meta}_\n\n${defuseTranscriptBody(memory.content).trim()}`;
        })
        .join('\n\n---\n\n')
    : '_This agent has no memories._';

  return withFrontmatter(
    {
      snaglet_kind: 'agent_memories',
      agent: agentName,
      agent_id: agentId,
      memory_count: memories.length,
      ...provenance(p),
    },
    body
  );
}

export function agentMemoriesFilename(agentName: string, agentId: string): string {
  // Sanitize the NAME before composing. Appending " memories" first would
  // guarantee a non-empty result, so an agent named "///" would silently
  // export as "memories.md" and the id fallback could never fire.
  const stem = safeFilename(agentName, '');
  return safeFilenameWithExtension(`${stem || agentId} memories`, '.md', `${agentId} memories`);
}

// Thread summary (renderer only)

/**
 * Thread summaries are not a top-level export kind: there is no summary pane
 * to export from, and a summary's meaningful home is inline in the
 * thread transcript as a compaction boundary. This maps a summary row onto the
 * transcript's compaction shape; `transcript.renderCompaction` renders it.
 */
export interface ThreadSummaryInput {
  agentId: string | null;
  summaryText: string;
  messagesCovered: number;
  lastMessageId: string | null;
  version: number;
  createdAt: string;
  /** `provider/model` stamp, or null on rows written before it was tracked. */
  modelUsed: string | null;
}

export function toCompaction(
  summary: ThreadSummaryInput,
  agentNameById: ReadonlyMap<string, string>
): {
  agentName: string;
  version: number;
  messagesCovered: number;
  createdAt: string;
  summaryText: string;
  lastMessageId: string | null;
  modelUsed: string | null;
} {
  return {
    // A bare id in a human-facing transcript is a bug; fall back only when the
    // agent row is genuinely gone.
    agentName: summary.agentId
      ? (agentNameById.get(summary.agentId) ?? summary.agentId)
      : 'unknown agent',
    version: summary.version,
    messagesCovered: summary.messagesCovered,
    createdAt: summary.createdAt,
    summaryText: summary.summaryText,
    lastMessageId: summary.lastMessageId,
    // Carried, not rendered here: which runtime wrote a summary is part of
    // reading it, and the transcript is the only artifact an export leaves.
    modelUsed: summary.modelUsed,
  };
}

// Image

/**
 * MIME -> extension. The stored MIME type is the authority, never the name the
 * user typed in the save dialog: a `.txt` PNG is a mislabeled file, and every
 * consumer downstream trusts the extension.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/x-icon': '.ico',
};

/** Unknown MIME yields `.bin` — honest about not knowing, rather than
 *  guessing an extension that would mislabel the bytes. */
export function extensionForMimeType(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.trim().toLowerCase().split(';')[0]] ?? '.bin';
}

/**
 * Image filename: the user's stem is kept (sanitized), the extension is
 * imposed from the stored MIME type.
 */
export function imageFilename(
  storedName: string,
  mimeType: string,
  requestedStem?: string
): string {
  const ext = extensionForMimeType(mimeType);
  const stem = requestedStem?.trim() || storedName;
  return safeFilenameWithExtension(stem, ext, safeFilename(storedName, 'image'));
}
