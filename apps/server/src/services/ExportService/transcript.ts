/**
 * transcript — rendering a thread as one readable markdown document.
 *
 * Pure over row-shaped input so the whole format is testable without a
 * database. `exportThread` supplies the rows.
 *
 * ## Why every structural marker is an HTML comment
 *
 * The exported markdown is the only artifact — there is no `messages.jsonl`
 * alongside it. So anything a reader or a future importer trusts in
 * this file has to be something a message body cannot fabricate. Message
 * `content` is raw user- and model-authored markdown: it can contain `---`,
 * `####`, blockquotes, and prose that reads exactly like a compaction record.
 *
 * Rather than guard each construct separately, every structural marker is
 * prefixed with one sentinel — `<!--snaglet:` — and message bodies have that exact
 * sentinel defused before they are written. One rule, one place, and it covers
 * speaker attributions and compaction boundaries alike. A body that contained
 * the sentinel renders it visibly (`&lt;!--snaglet:`) rather than hiding it, so the
 * reader can see that the message tried.
 */

import { formatModelUsed } from '@snaglet/shared/utils';
import { renderFrontmatter, type Frontmatter } from './frontmatter';

/** Marker every structural element carries. Never emitted from message text. */
const MARKER = '<!--snaglet:';

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Resolved display name — never a bare id (see resolveSpeaker). */
  speaker: string;
  content: string;
  createdAt: string;
  messageType: 'message' | 'question';
  runId: string | null;
}

export interface TranscriptCompaction {
  agentName: string;
  version: number;
  messagesCovered: number;
  createdAt: string;
  summaryText: string;
  /** The message this compaction was watermarked at. */
  lastMessageId: string | null;
  /**
   * `provider/model` stamp for the runtime that wrote the summary, or null on
   * rows persisted before provenance was tracked.
   */
  modelUsed: string | null;
}

export interface TranscriptWindow {
  /** Messages actually written, oldest first. */
  messages: readonly TranscriptMessage[];
  /** Total messages in the thread, regardless of the window. */
  messagesAvailable: number;
  /** `all`, or `last_500` style. */
  selection: string;
}

/**
 * Neutralize the structural sentinel inside message text.
 *
 * Escapes the `<` rather than deleting or rewriting the content: the text
 * still says what it said, it simply renders as visible characters instead of
 * being mistaken for a marker Snaglet emitted.
 */
export function defuseTranscriptBody(body: string): string {
  return body.replace(/<!--(\s*snaglet:)/gi, '&lt;!--$1');
}

/** `2026-01-14T09:12:33.000Z` -> `2026-01-14 09:12`. UTC, declared in the header. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Compactions that fall inside the exported window.
 *
 * A boundary whose watermark message was never written would reference
 * content that is not in the file — a transcript citing messages the reader
 * cannot see. Those are dropped here and accounted for in the banner instead.
 */
export function compactionsInWindow(
  compactions: readonly TranscriptCompaction[],
  messages: readonly TranscriptMessage[]
): TranscriptCompaction[] {
  const present = new Set(messages.map((m) => m.id));
  return compactions.filter((c) => c.lastMessageId !== null && present.has(c.lastMessageId));
}

function renderCompaction(compaction: TranscriptCompaction): string {
  // Provenance rides on the header, never inside the quoted summary: the body
  // below is model-authored prose that gets embedded and quoted verbatim, and
  // machine metadata does not belong in it. A row with no stamp (written before
  // provenance was tracked) simply omits the segment rather than showing an
  // empty one.
  const model = formatModelUsed(compaction.modelUsed);
  const head =
    `**context compacted** · ${compaction.agentName} · v${compaction.version} · ` +
    `covering ${compaction.messagesCovered} messages · ${formatTimestamp(compaction.createdAt)}` +
    (model ? ` · ${model}` : '');
  // Summary text is model-authored: defuse it exactly like a message body.
  const quoted = defuseTranscriptBody(compaction.summaryText)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return [`${MARKER}compaction-->`, `> ${head}`, '>', quoted, `${MARKER}/compaction-->`].join('\n');
}

function renderMessage(message: TranscriptMessage): string {
  const parts = [message.speaker];
  if (message.role === 'assistant') parts.push('_(assistant)_');
  parts.push(formatTimestamp(message.createdAt));
  if (message.runId) parts.push(`\`${message.runId}\``);

  const lines = [`${MARKER}msg-->`, `#### ${parts.join(' · ')}`];
  // `question` is a distinct message_type and must not silently render as an
  // ordinary message — the markdown is the only artifact, so what it omits is
  // omitted permanently.
  if (message.messageType === 'question') lines.push('', '_(question)_');
  lines.push('', defuseTranscriptBody(message.content).trim());
  return lines.join('\n');
}

/**
 * The visible truncation banner.
 *
 * Frontmatter is for machines; a human scrolling the file has to be able to
 * see that they are holding a slice. Returns null when nothing was cut.
 */
export function renderTruncationBanner(
  window: TranscriptWindow,
  droppedCompactions: number
): string | null {
  const written = window.messages.length;
  if (written >= window.messagesAvailable) return null;

  const earliest = window.messages[0];
  const parts = [
    `⚠ Showing the last ${written.toLocaleString('en-US')} of ` +
      `${window.messagesAvailable.toLocaleString('en-US')} messages.`,
  ];
  if (earliest) parts.push(`Earliest included: ${formatTimestamp(earliest.createdAt)}.`);
  if (droppedCompactions > 0) {
    // Says it once here rather than emitting a partial boundary mid-file.
    parts.push(
      `This window starts mid-conversation: ${droppedCompactions} earlier ` +
        `context compaction${droppedCompactions === 1 ? '' : 's'} ` +
        'happened before it and are not shown.'
    );
  }
  return `> ${parts.join(' ')}`;
}

/**
 * Render the transcript body (everything after the frontmatter).
 *
 * Compaction boundaries are emitted immediately after the message they were
 * watermarked at, which is where the compaction actually happened.
 */
export function renderTranscriptBody(
  window: TranscriptWindow,
  compactions: readonly TranscriptCompaction[]
): string {
  const inWindow = compactionsInWindow(compactions, window.messages);
  const dropped = compactions.length - inWindow.length;
  const byWatermark = new Map<string, TranscriptCompaction[]>();
  for (const compaction of inWindow) {
    if (!compaction.lastMessageId) continue;
    const list = byWatermark.get(compaction.lastMessageId) ?? [];
    list.push(compaction);
    byWatermark.set(compaction.lastMessageId, list);
  }

  const blocks: string[] = [];
  const banner = renderTruncationBanner(window, dropped);
  if (banner) blocks.push(banner);

  for (const message of window.messages) {
    blocks.push(renderMessage(message));
    for (const compaction of byWatermark.get(message.id) ?? []) {
      blocks.push(renderCompaction(compaction));
    }
  }

  if (window.messages.length === 0) blocks.push('_This thread has no messages._');
  return blocks.join('\n\n');
}

/** The full `.md`: header + transcript. */
export function renderTranscript(
  header: Frontmatter,
  window: TranscriptWindow,
  compactions: readonly TranscriptCompaction[]
): string {
  return `${renderFrontmatter(header)}\n${renderTranscriptBody(window, compactions)}\n`;
}
