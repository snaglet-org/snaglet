import path from 'node:path';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Agents } from '@snaglet/db/tables/agents';
import { isExtractableFileExtension } from '@snaglet/shared/constants';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { KIND_GLYPH } from '@server/services/ToolService/lib/workspaceScope';
import { activeRunMarker, getThreadActivity } from '@server/services/activeThreadRuns';
import { fmtLink, trimToOneLine, trimUntrustedToOneLine } from './helpers';
import { formatRelativeTime } from '@snaglet/shared/utils';
import type { CandidateCard } from '@server/services/search/candidateCards';
import type { SearchHit } from './types';
import { isAgentRunEndedRow } from '@server/services/SocketService/agentRunEnded';
import { MESSAGES_PER_THREAD as THREAD_MESSAGE_LIMIT } from './types';
import { containerCategoryMarker } from '@server/services/ToolService/lib/containerCategoryMarker';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';

// Workspace content (doc/message/memory/thread-summary bodies, image
// descriptions) renders with no visible notice: it is the workspace's own
// text, and the operating prompt already says text read through tools is
// information, not instructions. Every snippet-ish field still goes through
// neutralizeSystemFraming so a forged `<system-reminder>` tag stays inert.

/** Per-result CardById map for the per-result evidence lines. */
export type SearchCardMap = Map<string, CandidateCard>;

/** Per-thread enrichment attached to thread hits before rendering. */
interface ThreadEnrichment {
  participants: string[];
  summary: string | null;
  messages: { author: string; when: string; preview: string }[];
  /** Inline `▶ running (<agent>)` activity marker; '' when the thread is idle. */
  activeRun: string;
}
export type ThreadEnrichmentMap = Map<string, ThreadEnrichment>;

function freshnessLabel(card: CandidateCard): string {
  switch (card.freshness.freshnessFit) {
    case 'fresh':
      return 'fresh';
    case 'recently_referenced':
      return 'recent';
    case 'old_but_still_relevant':
      return 'aging';
    case 'possibly_stale':
      return 'stale?';
    case 'stale':
      return 'stale';
    default:
      return '';
  }
}

function scopeLabel(card: CandidateCard): string {
  switch (card.scope.scopeFit) {
    case 'current_thread':
      return 'this thread';
    case 'current_project':
      return 'this project';
    case 'linked_to_current_thread':
    case 'linked_to_current_project':
      return 'linked';
    case 'same_container_tree':
      return 'this subtree';
    case 'out_of_scope':
      return 'other project';
    default:
      return ''; // 'global' is the implied default — omit to keep the line tight
  }
}

function whyLabel(card: CandidateCard): string {
  const c = card.scores.channels;
  if (c.includes('vector')) return 'semantic';
  if (c.includes('fts')) return 'keyword';
  if (c.includes('fuzzy')) return 'fuzzy name';
  if (c.includes('graph')) return 'linked';
  return '';
}

/**
 * Compact per-result evidence line. One line, ≤ ~15 tokens:
 * freshness · scope · why-matched. Kind is already the glyph on the header,
 * so it is not repeated here. Omitted fields (global scope) drop out so the
 * line stays tight.
 */
function evidenceLine(card: CandidateCard | null | undefined): string {
  if (!card) return '';
  const parts = [freshnessLabel(card), scopeLabel(card), whyLabel(card)].filter(Boolean);
  return parts.length ? `  ↳ ${parts.join(' · ')}` : '';
}

// Re-exported so sibling modules (e.g. hydration.ts) can import this helper
// from the formatter barrel rather than reaching into ./helpers directly.
export { trimUntrustedToOneLine };

/**
 * Per-thread enrichment used by both text-search results and id-resolved
 * thread hits. Returns a map keyed by thread id; threads not in the input
 * list are absent.
 */
export async function buildThreadEnrichment(threadIds: string[]): Promise<ThreadEnrichmentMap> {
  const map: ThreadEnrichmentMap = new Map();
  if (threadIds.length === 0) return map;
  // One batched active-run lookup for the whole result set (not per thread).
  const activityByThread = await getThreadActivity(threadIds);
  await Promise.all(
    threadIds.map(async (id) => {
      const [participants, summaryRow] = await Promise.all([
        ThreadParticipants.listByThread(id),
        ThreadSummaries.getByThread(id),
      ]);
      // Only fetch recent messages when no summary exists — avoids unnecessary DB reads
      const messages = summaryRow
        ? []
        : await Messages.listRecentByThreadId(id, THREAD_MESSAGE_LIMIT);
      const participantAgentIds = participants
        .map((p) => p.agentId)
        .filter((id): id is string => Boolean(id));
      const agentRows = await Agents.findByIds(participantAgentIds);
      const nameByAgent = new Map(agentRows.map((a) => [a.id, a.name]));
      map.set(id, {
        participants: participants
          .map((p) => (p.agentId ? (nameByAgent.get(p.agentId) ?? p.agentId) : null))
          .filter((name): name is string => Boolean(name)),
        summary: summaryRow?.summaryText ?? null,
        messages: messages
          .filter((m) => !isAgentRunEndedRow(m))
          .map((m) => ({
            author: m.role === 'user' ? 'user' : (nameByAgent.get(m.agentId ?? '') ?? m.role),
            when: formatRelativeTime(m.createdAt),
            // Neutralize before truncating (see helpers.ts): this preview is
            // attacker-reachable message content, and renderHit's thread branch
            // below only re-neutralizes the already-built preview, too late
            // to catch a forged tag padded to straddle this cutoff.
            preview: trimUntrustedToOneLine(m.content ?? ''),
          })),
        activeRun: activeRunMarker(activityByThread.get(id)),
      });
    })
  );
  return map;
}

export function renderResults(
  query: string,
  hits: SearchHit[],
  threadEnrichment: ThreadEnrichmentMap,
  cardById?: SearchCardMap
): string {
  const lines: string[] = [];
  lines.push(`${hits.length} result(s) for "${query}":`);
  lines.push('');

  const evidenceLines = hits.map((hit) => evidenceLine(cardById?.get(hit.id)));
  // Hoist only complete, identical evidence: missing or mixed cards must stay
  // per-hit so a result never inherits another result's scope or freshness.
  const sharedEvidence =
    hits.length > 1 && evidenceLines[0] && evidenceLines.every((line) => line === evidenceLines[0])
      ? evidenceLines[0]
      : '';
  if (sharedEvidence) lines.push(`All results: ${sharedEvidence.slice('  ↳ '.length)}`, '');

  for (const [index, hit] of hits.entries()) {
    lines.push(renderHit(hit, threadEnrichment));
    const evidence = evidenceLines[index];
    if (evidence && !sharedEvidence) lines.push(evidence);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Render the dedicated FILE LANE as its own labeled section. Files are excluded
 * from the shared default pool (they flood non-code queries), so when a code-ish
 * query surfaces them via the lane they are shown separately and clearly marked —
 * never interleaved into the shared results. Returns '' when there are no file
 * hits so callers can conditionally append it.
 */
export function renderFileLane(fileHits: SearchHit[]): string {
  if (fileHits.length === 0) return '';
  const lines: string[] = [
    `Files (${fileHits.length}) — file lane, triggered by a code-ish query. ` +
      `Files are excluded from the default search pool; pass kinds:['file'] to search them directly.`,
    '',
  ];
  for (const hit of fileHits) {
    lines.push(renderHit(hit, new Map()));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function renderHit(hit: SearchHit, threadEnrichment: ThreadEnrichmentMap): string {
  const updated = formatRelativeTime(hit.updatedAt);

  if (hit.kind === 'doc') {
    const link = fmtLink('doc', hit.id, hit.title);
    const channels = hit.channels?.length ? ` · ${hit.channels.join('+')}` : '';
    const score = typeof hit.score === 'number' ? ` · score ${hit.score.toFixed(4)}` : '';
    return [
      `${KIND_GLYPH.doc} ${link} · ${updated}${channels}${score}`,
      `  ${neutralizeSystemFraming(hit.snippet)}`,
    ].join('\n');
  }

  if (hit.kind === 'thread') {
    const link = fmtLink('thread', hit.id, hit.title);
    const detail = threadEnrichment.get(hit.id);
    const runMarker = detail?.activeRun ? ` · ${detail.activeRun}` : '';
    const lines = [`${KIND_GLYPH.thread} ${link} · ${updated}${runMarker}`];
    if (detail) {
      const participants =
        detail.participants.length > 0 ? detail.participants.join(', ') : '(no participants)';
      lines.push(`  Participants: ${participants}`);
      if (detail.summary) {
        lines.push('  Summary:', `  ${neutralizeSystemFraming(detail.summary)}`);
      } else if (detail.messages.length === 0) {
        lines.push('  (no messages yet)');
      } else {
        lines.push(`  Last ${detail.messages.length} message(s):`);
        for (const m of detail.messages) {
          lines.push(`    [${m.author} · ${m.when}] ${neutralizeSystemFraming(m.preview)}`);
        }
      }
    }
    return lines.join('\n');
  }

  if (hit.kind === 'message') {
    const link = linkForm('message', hit.id, 'Message');
    const threadLink = linkForm('thread', hit.threadId, hit.threadTitle);
    const channels = hit.channels?.length ? ` · ${hit.channels.join('+')}` : '';
    const score = typeof hit.score === 'number' ? ` · score ${hit.score.toFixed(4)}` : '';
    return [
      `💬 ${link} · ${updated}${channels}${score}`,
      `  Thread: ${threadLink} (${hit.threadId})`,
      `  Sender: ${hit.sender}`,
      `  Date: ${hit.sentAt}`,
      `  ${neutralizeSystemFraming(hit.snippet)}`,
    ].join('\n');
  }

  if (hit.kind === 'container') {
    const link = fmtLink('container', hit.id, hit.name);
    const marker = containerCategoryMarker(hit.category);
    const categoryTag = marker ? ` · ${marker}` : '';
    return [
      `${KIND_GLYPH.container} ${link} · ${updated}${categoryTag}`,
      `  Path: ${hit.path}`,
    ].join('\n');
  }

  if (hit.kind === 'memory') {
    const link = linkForm('memory', hit.id, hit.key || 'Memory');
    const lines = [`🧠 ${link} · ${updated}`];
    if (hit.agentId) lines.push(`  Owner: ${hit.agentId}`);
    if (hit.sourceThreadId)
      lines.push(`  Source thread: ${linkForm('thread', hit.sourceThreadId, hit.sourceThreadId)}`);
    // trimUntrustedToOneLine neutralizes before it truncates: neutralizing
    // after a plain trimToOneLine cutoff can't fix a forged tag already cut
    // mid-tag by the slice.
    lines.push(`  ${trimUntrustedToOneLine(hit.content ?? '', 200) || '(empty)'}`);
    return lines.join('\n');
  }

  if (hit.kind === 'thread_summary') {
    const link = linkForm('thread_summary', hit.id, 'Thread summary');
    const lines = [`🧾 ${link} · ${updated}`];
    lines.push(`  Thread: ${linkForm('thread', hit.threadId, hit.threadTitle)} (${hit.threadId})`);
    if (hit.agentId) lines.push(`  Agent: ${hit.agentId}`);
    // Same neutralize-before-truncate ordering as the memory branch above.
    lines.push(`  ${trimUntrustedToOneLine(hit.summaryText ?? '', 200) || '(empty summary)'}`);
    return lines.join('\n');
  }

  if (hit.kind === 'tool') {
    const safeName = (hit.name || hit.id).replace(/[\]\\]/g, '\\$&');
    const link = `[${safeName}](tool:${hit.id})`;
    const lines = [
      `🔧 ${link} · ${updated} · ${hit.tier} · ${hit.categoryPath} · ${hit.enabled ? 'enabled' : 'disabled'}`,
    ];
    if (hit.description) lines.push(`  ${trimToOneLine(hit.description, 200)}`);
    return lines.join('\n');
  }

  if (hit.kind === 'image') {
    const sizeKb = (hit.sizeBytes / 1024).toFixed(1);
    const tags = hit.tags.length > 0 ? ` · tags: ${hit.tags.join(', ')}` : '';
    // Inline the markdown link instead of routing through linkForm — `image`
    // isn't in LinkNodeType yet, but the id itself is self-identifying
    // (the `image-` prefix matches PREFIXED_NODE_ID_RE at parse time).
    const safeName = (hit.name || 'Untitled image').replace(/[\]\\]/g, '\\$&');
    const link = `[${safeName}](${hit.id})`;
    const lines = [`🖼️ ${link} · ${updated} · ${hit.mimeType} · ${sizeKb} KB${tags}`];
    // image.description is agent-writable via the always-enabled
    // image_update_metadata tool with no write-time sanitization, so it gets
    // the same neutralize-before-truncate treatment as the memory/thread_summary
    // branches above — a bare trimToOneLine here would let a forged
    // <system-reminder> tag through untouched (or, if padded past the 200-char
    // cutoff, truncated mid-tag into a still-live fragment).
    if (hit.description) lines.push(`  ${trimUntrustedToOneLine(hit.description, 200)}`);
    lines.push(
      `  Use \`file\` (op:read, mode:image) with \`id\` set to this id to load the bytes for a vision model.`
    );
    return lines.join('\n');
  }

  if (hit.kind === 'file') {
    const channels = hit.channels?.length ? ` · ${hit.channels.join('+')}` : '';
    const score = typeof hit.score === 'number' ? ` · score ${hit.score.toFixed(4)}` : '';
    // `file` isn't a LinkNodeType; the `file-` id prefix is self-identifying
    // (PREFIXED_NODE_ID_RE), so inline the markdown link like the image case.
    const safe = hit.relativePath.replace(/[\]\\]/g, '\\$&');
    const link = `[${safe}](${hit.id})`;
    const sizeKb = (hit.sizeBytes / 1024).toFixed(1);
    // Line-range surfacing ("grep-with-semantics"): when the match came from a
    // specific embedded chunk (vector channel), surface that chunk's byte range
    // so the result points at the matched region, not just the file. Offsets are
    // byte offsets into the file body (not line numbers) — honest about what the
    // embeddings table actually stores (chunk_start/chunk_end). Extractable
    // files (PDF) embed their DERIVED text layer, so their offsets are char
    // positions in the extracted text, not in the binary — label them as such.
    const hasChunkRange = typeof hit.chunkStart === 'number' && typeof hit.chunkEnd === 'number';
    const extracted = isExtractableFileExtension(path.extname(hit.relativePath));
    const rangeLabel = extracted
      ? `chars ${hit.chunkStart}–${hit.chunkEnd} of extracted text`
      : `bytes ${hit.chunkStart}–${hit.chunkEnd}`;
    const chunkLine = hasChunkRange
      ? `\n  ↳ matched chunk #${hit.chunkIndex ?? 0} · ${rangeLabel}`
      : '';
    // Content-addressed dedup: the same bytes may be referenced by several
    // projects/paths — one hit, all owners listed.
    const extraPaths = (hit.paths ?? []).filter(
      (p) => p.projectId !== hit.projectId || p.relativePath !== hit.relativePath
    );
    const sharedLine =
      extraPaths.length > 0
        ? `\n  ↳ same content also at: ${extraPaths
            .map((p) => `${p.relativePath} (project ${p.projectId})`)
            .join(', ')}`
        : '';
    return [
      `📎 ${link} · ${updated}${channels}${score}`,
      `  Local file · ${sizeKb} KB · project ${hit.projectId}${chunkLine}${sharedLine}`,
    ].join('\n');
  }

  return '';
}

export function formatSnippet(raw: string | null | undefined): string {
  const snippet = raw?.trim() ?? '';
  if (!snippet) return '(match in title)';
  const stripped = snippet.replace(/\*\*$/, '');
  const lastChar = stripped.slice(-1);
  if (/[.!?…)"']/.test(lastChar)) return snippet;
  return `${snippet}…`;
}

// Re-exported from ./resolvers.js so existing consumers keep importing from
// formatters. The ID-resolution cluster was extracted to keep this file focused
// on search-hit rendering.
export { looksLikeSearchId, renderResolvedIds } from './resolvers';
