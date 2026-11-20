/**
 * ExportService — write a workspace node to a folder the user chose, or hand
 * back the bytes for a browser download.
 *
 * Boundaries this module owns:
 *  - **Provenance is derived, never accepted.** `exported_by` comes from the
 *    ambient actor. If the caller could supply it, the one line in the file
 *    that says who produced it would be forgeable, which would quietly void
 *    the point of stamping it at all.
 *  - **Overwrite is an identity decision** (see writeTarget) — only an
 *    authenticated human, who has already answered the OS dialog's "replace?",
 *    may clobber.
 *  - **No `destDir` means no write.** The browser path returns bytes and
 *    touches the filesystem zero times; it is not a degraded write path.
 *
 * Authorization is not decided here. Callers (route, agent tool) resolve which
 * agent's memories may be read and pass it in as `allowedAgentId`; this module
 * enforces that constraint but does not invent it.
 */

import { getDb } from '@snaglet/db';
import { Docs } from '@snaglet/db/tables/docs';
import { Threads } from '@snaglet/db/tables/threads';
import { Messages } from '@snaglet/db/tables/messages';
import { Memories } from '@snaglet/db/tables/memories';
import { Agents } from '@snaglet/db/tables/agents';
import { Images } from '@snaglet/db/tables/images';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { getCurrentActor } from '@server/realtime/actorContext';
import { resolveExportDir, resolveExportTarget } from './exportPaths';
import { verifyOverwriteGrant } from './overwriteGrant';
import { safeFilename, safeFilenameWithExtension } from './safeFilename';
import { writeExport } from './writeTarget';
import { renderTranscript, type TranscriptMessage } from './transcript';
import { exportContainer, type ContainerExportReport } from './containerExport';
import {
  agentMemoriesFilename,
  docFilename,
  imageFilename,
  serializeAgentMemories,
  serializeDoc,
  toCompaction,
  type ExportProvenance,
  type MemoryExportInput,
} from './serializers';

export const EXPORT_KINDS = ['doc', 'thread', 'image', 'agent_memories', 'container'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Kinds an external MCP client may export. Agent memories are deliberately
 *  absent — see the tool/projection layer for the reasoning. */
export const EXTERNAL_EXPORT_KINDS: readonly ExportKind[] = ['doc', 'thread', 'image'];

export interface ExportOptions {
  /** Thread only: write just the newest N messages. Omitted means all. */
  messageLimit?: number;
  /**
   * Signed proof from the native save dialog that the user selected — and was
   * asked about replacing — this exact path.
   *
   * This is the only thing that can authorize an overwrite. There is
   * deliberately no boolean: a caller-set flag says "I would like to
   * overwrite", which every caller can say, and is not evidence that the OS
   * ever showed a replace prompt. See overwriteGrant.ts.
   */
  overwriteGrant?: string;
}

export interface ExportRequest {
  kind: ExportKind;
  /** doc id / thread id / image id / agent id, per kind. */
  id: string;
  /** Absent => return bytes for download, write nothing. */
  destDir?: string;
  /** The stem the user chose in the save dialog. Sanitized, never trusted. */
  fileName?: string;
  options?: ExportOptions;
  /**
   * The only agent whose memories this caller may read. Required for
   * `agent_memories`; a mismatch is refused rather than silently narrowed.
   */
  allowedAgentId?: string | null;
}

export interface ExportPayload {
  fileName: string;
  data: Buffer;
  contentType: string;
}

export interface ExportResult {
  kind: ExportKind;
  id: string;
  fileName: string;
  bytes: number;
  /** Absolute path written; absent on the download path. */
  path?: string;
  overwritten?: boolean;
  /** True when bytes were returned instead of written. */
  downloaded: boolean;
  /** Container exports write a completion manifest inside the new folder. */
  manifestPath?: string;
  /** Per-node completion details for recursive container exports. */
  report?: ContainerExportReport;
}

function notFound(what: string): never {
  throw new AppError(what, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

function appVersion(): string {
  return (
    process.env.SNAGLET_APP_VERSION?.trim() || process.env.npm_package_version?.trim() || '0.1.0'
  );
}

/**
 * Who is exporting, from ambient context only.
 *
 * A missing actor is recorded as `unknown` rather than guessed at. The stamp
 * is either true or it says it does not know; it never flatters the caller.
 */
export function currentProvenance(now: string = new Date().toISOString()): ExportProvenance {
  const actor = getCurrentActor();
  const name = actor?.actorName?.trim();
  return {
    exportedAt: now,
    exportedBy: name || actor?.actorId || 'unknown',
    snagletVersion: appVersion(),
  };
}

/**
 * May this write replace an existing file at `resolvedTarget`?
 *
 * Two independent conditions, both required:
 *  1. an authenticated HUMAN actor — agents and external MCP clients never
 *     overwrite, whatever they present;
 *  2. a valid, unexpired, unreplayed grant **bound to this exact path**.
 *
 * (2) is what makes (1) meaningful. Actor kind alone was the original bug:
 * any browser or API request carrying a human session could set a boolean and
 * be believed. Only the native dialog can produce a grant, because only the
 * Rust shell holds the key.
 */
export function mayOverwrite(options: ExportOptions | undefined, resolvedTarget: string): boolean {
  if (getCurrentActor()?.actorKind !== 'user') return false;
  return verifyOverwriteGrant(options?.overwriteGrant, resolvedTarget).ok;
}

/**
 * Every memory belonging to one agent.
 *
 * Completeness is the model's guarantee, not this function's: `listAllByAgent`
 * pages by a total order inside a REPEATABLE READ snapshot. An offset loop
 * here over the mutable `updated_at` sort would skip and duplicate rows, and
 * the resulting short file would still describe itself as complete — which is
 * the one thing an "everything this agent knows" export must never do.
 */
async function loadAllAgentMemories(agentId: string): Promise<MemoryExportInput[]> {
  const rows = await Memories.listAllByAgent(agentId);
  return rows.map((row) => ({
    id: row.id,
    key: row.key ?? null,
    content: row.content,
    agentName: null,
    sourceThreadId: row.sourceThreadId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  }));
}

async function buildDocPayload(id: string, p: ExportProvenance): Promise<ExportPayload> {
  const doc = await Docs.findById(id);
  if (!doc) notFound(`Doc not found: ${id}`);
  return {
    fileName: docFilename(doc),
    data: Buffer.from(
      serializeDoc(
        {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          containerId: doc.containerId ?? null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        },
        p
      ),
      'utf8'
    ),
    contentType: 'text/markdown; charset=utf-8',
  };
}

async function buildThreadPayload(
  id: string,
  options: ExportOptions | undefined,
  p: ExportProvenance
): Promise<ExportPayload> {
  const thread = await Threads.findById(id);
  if (!thread) notFound(`Thread not found: ${id}`);

  const limit = options?.messageLimit;
  // listRecentByThreadId already re-sorts ascending, which is the reading
  // order the transcript wants — no re-sort here.
  const rows =
    limit && limit > 0
      ? await Messages.listRecentByThreadId(id, limit)
      : await Messages.listByThreadId(id);
  const messagesAvailable = await Messages.countByThreadId(id);
  const summaries = await ThreadSummaries.getHistoryByThread(id);

  const agentIds = [
    ...new Set(
      [...rows.map((r) => r.agentId), ...summaries.map((s) => s.agentId)].filter((v): v is string =>
        Boolean(v)
      )
    ),
  ];
  // Resolved once into a map — a bare id in a human-facing transcript is a bug.
  const agents = agentIds.length ? await Agents.findByIds(agentIds) : [];
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const messages: TranscriptMessage[] = rows.map((row) => ({
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    speaker: row.agentId ? (nameById.get(row.agentId) ?? row.agentId) : 'You',
    content: row.content,
    createdAt: row.createdAt,
    messageType: row.messageType === 'question' ? 'question' : 'message',
    runId: row.runId ?? null,
  }));

  const compactions = summaries.map((s) => toCompaction(s, nameById));
  const written = messages.length;
  const truncated = written < messagesAvailable;
  const selection = limit && limit > 0 ? `last_${limit}` : 'all';

  const data = renderTranscript(
    {
      snaglet_kind: 'thread',
      id: thread.id,
      title: thread.title,
      project_id: thread.projectId,
      dispatch_mode: thread.dispatchMode,
      participants: agents.map((a) => ({ agent_id: a.id, name: a.name })),
      created_at: thread.createdAt ?? null,
      last_message_at: thread.lastMessageAt ?? null,
      message_count: written,
      messages_available: messagesAvailable,
      message_selection: selection,
      truncated,
      compactions: compactions.map((c) => ({
        agent: c.agentName,
        version: c.version,
        messages_covered: c.messagesCovered,
        created_at: c.createdAt,
      })),
      exported_at: p.exportedAt,
      exported_by: p.exportedBy,
      snaglet_version: p.snagletVersion,
      timestamps: 'UTC',
    },
    { messages, messagesAvailable, selection },
    compactions
  );

  const title = thread.title?.trim();
  return {
    // Title first so a Finder window is browsable; id retained so exports stay
    // collision-free and machine-resolvable.
    fileName: `${title ? `${title} (${thread.id})` : thread.id}.md`,
    data: Buffer.from(data, 'utf8'),
    contentType: 'text/markdown; charset=utf-8',
  };
}

async function buildImagePayload(id: string, requestedStem?: string): Promise<ExportPayload> {
  const image = await Images.findImageById(id);
  if (!image) notFound(`Image not found: ${id}`);
  // The stored bytes from whichever source the row uses (its blob key or an
  // inline data URL): an export is a byte-for-byte copy, not a re-encode.
  if (image.data.length === 0) notFound(`Image bytes are missing for ${id}`);
  return {
    fileName: imageFilename(image.name, image.mimeType, requestedStem),
    data: image.data,
    contentType: image.mimeType,
  };
}

async function buildAgentMemoriesPayload(
  agentId: string,
  allowedAgentId: string | null | undefined,
  p: ExportProvenance
): Promise<ExportPayload> {
  if (allowedAgentId === undefined || allowedAgentId === null) {
    throw new AppError(
      'Exporting agent memories requires a resolved agent identity.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.FORBIDDEN
    );
  }
  if (allowedAgentId !== agentId) {
    // Refused rather than narrowed to the allowed agent: silently exporting
    // someone else's memories under the requested name would be worse.
    throw new AppError(
      'You may not export another agent’s memories.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.FORBIDDEN
    );
  }

  const agent = await Agents.findById(agentId);
  if (!agent) notFound(`Agent not found: ${agentId}`);
  const memories = await loadAllAgentMemories(agentId);
  return {
    fileName: agentMemoriesFilename(agent.name, agent.id),
    data: Buffer.from(
      serializeAgentMemories(
        agent.name,
        agent.id,
        memories.map((m) => ({ ...m, agentName: agent.name })),
        p
      ),
      'utf8'
    ),
    contentType: 'text/markdown; charset=utf-8',
  };
}

/** Serialize `request` to bytes. Never touches the filesystem. */
export async function buildExportPayload(request: ExportRequest): Promise<ExportPayload> {
  const p = currentProvenance();
  switch (request.kind) {
    case 'doc':
      return buildDocPayload(request.id, p);
    case 'thread':
      return buildThreadPayload(request.id, request.options, p);
    case 'image':
      return buildImagePayload(request.id, request.fileName);
    case 'agent_memories':
      return buildAgentMemoriesPayload(request.id, request.allowedAgentId, p);
    case 'container':
      throw new AppError(
        'Container exports require a destination folder.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    default:
      throw new AppError(
        `Unsupported export kind: ${String(request.kind)}`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
  }
}

/**
 * Run an export.
 *
 * With `destDir` the bytes are written into that (guarded) folder and the
 * result carries the absolute path. Without it, nothing is written and the
 * caller streams `payload.data` to the browser.
 */
export async function runExport(
  request: ExportRequest
): Promise<{ result: ExportResult; payload?: ExportPayload }> {
  if (request.kind === 'container') {
    if (!request.destDir?.trim()) {
      throw new AppError(
        'Container exports require an existing destination folder.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const outcome = await exportContainer(request.id, request.destDir, currentProvenance());
    return {
      result: {
        kind: 'container',
        id: request.id,
        fileName: outcome.directoryName,
        bytes: outcome.bytes,
        path: outcome.path,
        overwritten: false,
        downloaded: false,
        manifestPath: outcome.manifestPath,
        report: outcome.report,
      },
    };
  }

  const payload = await buildExportPayload(request);

  // The user's chosen stem wins for text kinds; images impose their extension
  // from the stored MIME type inside imageFilename, so it is already applied.
  const fileName =
    request.kind !== 'image' && request.fileName?.trim()
      ? applyRequestedName(request.fileName, payload.fileName)
      : payload.fileName;

  if (!request.destDir?.trim()) {
    return {
      payload: { ...payload, fileName },
      result: {
        kind: request.kind,
        id: request.id,
        fileName,
        bytes: payload.data.byteLength,
        downloaded: true,
      },
    };
  }

  const resolvedDir = await resolveExportDir(request.destDir);
  // The grant is checked against the RESOLVED target, not the requested one:
  // a grant for a harmless-looking name must not authorize a write to
  // whatever that name resolves to after sanitization and symlink resolution.
  const resolvedTarget = resolveExportTarget(resolvedDir, fileName);
  const outcome = await writeExport(
    resolvedDir,
    fileName,
    payload.data,
    mayOverwrite(request.options, resolvedTarget)
  );
  return {
    payload: { ...payload, fileName: outcome.fileName },
    result: {
      kind: request.kind,
      id: request.id,
      fileName: outcome.fileName,
      bytes: payload.data.byteLength,
      path: outcome.path,
      overwritten: outcome.overwritten,
      downloaded: false,
    },
  };
}

/**
 * Keep the caller's stem, keep the serializer's extension.
 *
 * The extension is never taken from the request: `safeFilenameWithExtension`
 * replaces whatever the caller typed with the one the serializer chose, so a
 * thread saved as `notes.txt` still lands as `notes.md`.
 */
function applyRequestedName(requested: string, derived: string): string {
  const dot = derived.lastIndexOf('.');
  const ext = dot === -1 ? '' : derived.slice(dot);
  const derivedStem = dot === -1 ? derived : derived.slice(0, dot);
  return ext
    ? safeFilenameWithExtension(requested, ext, derivedStem)
    : safeFilename(requested, derived);
}
