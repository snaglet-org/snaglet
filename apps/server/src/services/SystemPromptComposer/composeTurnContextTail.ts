/**
 * composeTurnContextTail — the per-turn EPHEMERAL context block.
 *
 * All the per-turn DATA that would otherwise bust the system-prompt cache is
 * consolidated into ONE user message, appended fresh after
 * all conversation history, every turn:
 *
 *   - current coordinates (host path, location — the project lineage or
 *     "workspace (no project)" — thread, routing)
 *   - project scope data (name, folder, repo, parent, indexed-files hint)
 *   - the dispatch soft-threshold note
 *   - the prior-run hint and pane-layout delta — passed in as `extras`
 *     (they need async DB reads the caller already does)
 *   - the automation-wake note ({@link composeAutomationWakeNote}), spliced
 *     in by the caller, which looks the automation up
 *   - the unread-DM note ({@link composeUnreadDmNote}), spliced in by the
 *     caller, which counts the agent's unread DMs
 *
 * This message is never persisted and never replayed: it is not part of the
 * conversation record, so the next turn's replay does not contain it. It sits
 * behind the message-tail cache breakpoint, so its per-turn variance costs only
 * the tail (a small, bounded miss), never the system prefix.
 *
 * Pure + deterministic given (ctx, extras): identical inputs → identical bytes.
 */

import type { SystemPromptContext } from './types';
import { VOICE_PROFILE_BLOCK } from '@server/services/SocketService/voiceSession/constants';
import { neutralizeUntrustedName } from '@server/services/ToolService/lib/untrustedContent';

/**
 * Stable sentinel PREFIX of the turn-context header. This is the single source
 * of truth used both to BUILD the header (below) and to DETECT the ephemeral
 * tail downstream (ContextWindowService.isConversationalUserMessage), so a
 * consumer scanning for the tail matches on a documented marker rather than
 * sniffing content. Keep it as an exact prefix of TURN_CONTEXT_HEADER.
 */
export const TURN_CONTEXT_SENTINEL = '[Turn context — not part of the conversation record';

/** Clearly delimits the block as out-of-record so the model never cites it as user speech. */
export const TURN_CONTEXT_HEADER = `${TURN_CONTEXT_SENTINEL}; refreshed every turn; do not quote it as something a participant said.]`;

/**
 * What each working-folder source means, for the line the agent reads. That
 * `shell` and `file` start in the working folder is said once, in the cached
 * system prompt (operatingContextBlock), not on every turn.
 */
const WORKING_FOLDER_SOURCE: Record<string, string> = {
  thread: 'set for this thread',
  project: "this project's linked folder",
  home: 'Snaglet home, because this thread has no project folder',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Coordinates + project scope + soft-threshold note, from ctx alone (sync). */
export function composeTurnContextData(ctx: SystemPromptContext): string {
  const params = ctx.runParams ?? {};
  const sections: string[] = [];

  const hostPath = str(params.host_path);
  const path = str(params.thread_path);
  const title = str(params.thread_title);
  const routing = str(params.thread_routing);
  const participants = str(params.thread_participants);

  const coord: string[] = ['**Your current coordinates:**'];
  if (hostPath) {
    const where = WORKING_FOLDER_SOURCE[str(params.host_path_source) ?? ''];
    coord.push(`- Working folder: \`${hostPath}\`${where ? ` (${where})` : ''}`);
  }
  if (path) coord.push(`- Location: \`${path}\``);
  // The id rides along so thread tools can target this thread without guessing.
  // Tail-only: never in the cached prefix.
  const threadId = str(ctx.threadId);
  if (title) coord.push(`- Thread: \`${title}\`${threadId ? ` (${threadId})` : ''}`);
  else if (threadId) coord.push(`- Thread: ${threadId}`);
  if (routing) coord.push(`- Routing mode: \`${routing}\``);
  // The roster is deliberately not restated here. Joins and departures persist
  // as thread_event rows and replay in order, so the transcript already carries
  // who is present; repeating it every turn would pay for derivable state on
  // every wake. `participants` is read above only to decide whether thread
  // coordinates resolved at all.
  if (!path && !title && !participants) {
    coord.push(
      '- Thread coordinates could not be resolved this turn; call `orient` if you need them.'
    );
  }
  sections.push(coord.join('\n'));

  const projectName = str(params.project_name);
  if (projectName) {
    const proj: string[] = [`**Project scope: \`${projectName}\`.**`];
    const folderPath = str(params.project_folder_path);
    const gitRepo = str(params.project_gitrepo);
    const parentProject = str(params.parent_project_name);
    if (folderPath) proj.push(`- Files on disk: \`${folderPath}\``);
    if (gitRepo) proj.push(`- Git repo: \`${gitRepo}\``);
    if (parentProject) proj.push(`- Sits inside parent project: \`${parentProject}\``);
    if (folderPath && ctx.embeddingsEnabled === true) {
      proj.push(
        `- Files in \`${folderPath}\` are indexed — \`search({kind: 'files', query})\` finds them by meaning.`
      );
    }
    sections.push(proj.join('\n'));
  }

  if (ctx.agentSoftThresholdNotified?.has(ctx.replyAgentId)) {
    const dispatches = ctx.agentDispatchCount?.get(ctx.replyAgentId) ?? 0;
    sections.push(
      `[System note: You have responded ${dispatches} times in this conversation turn. Reply again only with something new. If you would restate, confirm or echo, reply with [PASS] on its own, or end your final note with [PASS] to post it and yield; [PASS] counts only at the end of a message.]`
    );
  }

  // Voice mode behavior block — present only while a voice session is active for
  // this thread (ctx.voiceModeActive, set by contextAssembly from the voice
  // registry). It rides the ephemeral tail, never the system prefix, so the
  // system prompt stays byte-identical across a voice toggle. Compact by design.
  if (ctx.voiceModeActive === true) {
    sections.push(VOICE_PROFILE_BLOCK);
  }

  return sections.join('\n\n');
}

/** The automation that started this turn, as the woken agent should read it. */
export interface AutomationWakeNoteInput {
  name: string;
  /** The woken agent created it itself (otherwise a person did). */
  scheduledByYou: boolean;
}

/**
 * The tail note for a turn an automation started. Without it the
 * `[automation <name>] @You <prompt>` message reads like a person announcing
 * a reminder, and the agent thanks them instead of doing the work; and it
 * answers in its reply, not with a separate thread send as well.
 */
export function composeAutomationWakeNote(wake: AutomationWakeNoteInput | null): string | null {
  if (!wake) return null;
  return `This turn was started by the automation "${wake.name}" (scheduled by ${
    wake.scheduledByYou ? 'you' : 'a person'
  }), not by someone typing, and nobody is waiting live. Carry out its prompt now and answer in your reply here, not in a separate message.`;
}

/** One sender's unread DM count, as {@link composeUnreadDmNote} reads it. */
export interface UnreadDmNoteSender {
  fromName: string;
  fromKind: 'agent' | 'user';
  count: number;
}

const UNREAD_DM_NOTE_MAX_SENDERS = 5;

/**
 * The turn-context line telling an agent it has unread DMs: names and counts
 * only, never a body (a DM is another party's text, so it is read through the
 * thread tool as data, not injected here). A user sender reads as "the user".
 * An agent name is actor-controlled (an agent can rename itself), so it goes
 * through neutralizeUntrustedName and stays one line with brackets escaped.
 * At most five senders are named, the rest folded into "and N more". Null when
 * nothing is unread. Pure.
 */
export function composeUnreadDmNote(summary: UnreadDmNoteSender[]): string | null {
  const senders = summary.filter((s) => s.count > 0);
  if (senders.length === 0) return null;
  const named = senders
    .slice(0, UNREAD_DM_NOTE_MAX_SENDERS)
    .map(
      (s) =>
        `${s.count} from ${s.fromKind === 'user' ? 'the user' : neutralizeUntrustedName(s.fromName)}`
    );
  const more = senders.length - named.length;
  const list = more > 0 ? `${named.join(', ')}, and ${more} more` : named.join(', ');
  return `Unread DMs: ${list}. Read them with the thread tool, op "dm_list" (see the snaglet-dms skill).`;
}

/**
 * Wrap already-rendered segments into the single ephemeral turn-context user
 * message. Empty/blank segments are dropped; returns null when nothing remains.
 * Kept separate from composeTurnContextData so the runtime caller can splice in
 * async segments (prior-run hint, pane-layout delta) it fetched itself without
 * re-deriving the sync data.
 */
export function buildTurnContextMessage(
  segments: Array<string | null | undefined>
): { role: 'user'; content: string; ephemeral: true } | null {
  const clean = segments.map((s) => (s ? s.trim() : '')).filter((s) => s.length > 0);
  if (clean.length === 0) return null;
  // `ephemeral: true` is the structural marker cache-breakpoint placement uses
  // to keep this per-turn, never-persisted block OUT of the durable cache
  // prefix (see applyMessageCacheBreakpoints). It replaces sentinel sniffing.
  return { role: 'user', content: [TURN_CONTEXT_HEADER, ...clean].join('\n\n'), ephemeral: true };
}

/**
 * Build the single ephemeral turn-context user message from a context plus any
 * already-fetched async `extras` (prior-run hint, pane-layout delta). Returns
 * null only when there is genuinely nothing to say.
 */
export function composeTurnContextTail(
  ctx: SystemPromptContext,
  extras: Array<string | null | undefined> = []
): { role: 'user'; content: string; ephemeral: true } | null {
  return buildTurnContextMessage([composeTurnContextData(ctx), ...extras]);
}
