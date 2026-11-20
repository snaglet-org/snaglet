/**
 * PerceptionService — Agent Perception Layer
 *
 * Each agent perceives the conversation through their own eyes.
 * In group chats, messages from other agents and humans are wrapped
 * in XML tags that give the model structural signals about who said what.
 * The agent's own messages stay as plain `role: "assistant"`.
 *
 * 1:1 chats are unchanged — no XML, backwards compatible.
 */

import { Messages } from '@snaglet/db/tables/messages';
import type { MessageRow } from '@snaglet/db/tables/messages';
import type { ProviderMessage, TextMessage } from './ProviderChatService';
import { settingsService } from './settings';
import { agentSettings } from './settings/categories/agent';
import { escapeXml } from '@snaglet/shared/utils/text';
import { resolveImageMarkers } from './imageMarkers';
import { logger } from '@server/config/logger';

type PerceptionType = 'self' | 'human' | 'peer_speech' | 'system_event';

interface BuildPerceptionOpts {
  threadId: string;
  agentId: string;
  isGroup: boolean;
  agentNameMap: Map<string, string>;
  agentRoleMap?: Map<string, string>;
  /** Override the default message limit. */
  messageLimit?: number;
}

export interface MentionContext {
  /** Whether this agent was @mentioned */
  isMentioned: boolean;
  /** Names of all @mentioned agents */
  mentionedAgentNames: string[];
  /** True when no @mentions were found (open floor) */
  isOpenFloor: boolean;
}

const MAX_PEER_CONTENT_LENGTH = 2000;

function classifyMessage(msg: MessageRow, agentId: string, isGroup: boolean): PerceptionType {
  // Own assistant message
  if (msg.role === 'assistant' && msg.agentId === agentId) {
    return 'self';
  }
  // Another agent's message
  if (msg.role === 'assistant' && msg.agentId && msg.agentId !== agentId) {
    return isGroup ? 'peer_speech' : 'human'; // shouldn't happen in 1:1
  }
  // User message
  if (msg.role === 'user') {
    return 'human';
  }
  // system/other
  return 'system_event';
}

function filterPeerContent(content: string): string {
  // Strip <thinking> blocks (some models expose internal reasoning)
  let filtered = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

  // Strip raw tool JSON blocks (tool_use artifacts)
  filtered = filtered.replace(/```json\s*\{[\s\S]*?"type"\s*:\s*"tool_use"[\s\S]*?```/g, '').trim();

  // Truncate very long responses
  if (filtered.length > MAX_PEER_CONTENT_LENGTH) {
    filtered = filtered.slice(0, MAX_PEER_CONTENT_LENGTH) + '\n[…response truncated]';
  }

  return filtered;
}

function wrapXml(type: PerceptionType, content: string, speaker?: string, role?: string): string {
  switch (type) {
    case 'human': {
      const speakerAttr = speaker ? ` speaker="${escapeXml(speaker)}"` : '';
      return `<human_message${speakerAttr}>\n${content}\n</human_message>`;
    }
    case 'peer_speech': {
      const speakerAttr = speaker ? ` speaker="${escapeXml(speaker)}"` : '';
      const roleAttr = role ? ` role="${escapeXml(role)}"` : '';
      return `<agent_message${speakerAttr}${roleAttr}>\n${content}\n</agent_message>`;
    }
    case 'system_event': {
      return `<room_event type="system">\n${content}\n</room_event>`;
    }
    default:
      return content;
  }
}

/**
 * Merge consecutive same-role messages.
 * Anthropic API requires alternating user/assistant roles.
 * Multiple XML blocks from different speakers get merged into one user message.
 */
function mergeConsecutiveRoles(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): TextMessage[] {
  if (messages.length === 0) return [];

  const merged: TextMessage[] = [];
  let current = { ...messages[0] };

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === current.role) {
      // Merge: separate XML blocks with a blank line
      current.content += '\n\n' + msg.content;
    } else {
      merged.push({ role: current.role, content: current.content });
      current = { ...msg };
    }
  }
  merged.push({ role: current.role, content: current.content });

  return merged;
}

/**
 * Build the message history as this agent perceives it.
 *
 * - Own messages → `role: "assistant"`, plain text
 * - Human messages → `role: "user"`, wrapped in `<human_message>` XML (group only)
 * - Peer agent messages → `role: "user"`, wrapped in `<agent_message>` XML
 * - Consecutive same-role messages are merged (API requirement)
 *
 * In 1:1 chats, no XML wrapping — identical to previous behavior.
 */
async function buildPerception(opts: BuildPerceptionOpts): Promise<ProviderMessage[]> {
  const startedAt = Date.now();
  const result = await buildPerceptionInner(opts);
  // Duration metric: the cap rose from 40 to a
  // 500-row safety ceiling — p95 here must stay flat as row counts grow.
  logger.info(
    `[perception] thread=${opts.threadId} agent=${opts.agentId} ` +
      `messages=${result.length} duration_ms=${Date.now() - startedAt}`
  );
  return result;
}

async function buildPerceptionInner(opts: BuildPerceptionOpts): Promise<ProviderMessage[]> {
  const { threadId } = opts;
  const configLimit = await settingsService.read(agentSettings.perceptionMaxMessages);
  const limit = opts.messageLimit ?? configLimit;
  const dbMessages = await Messages.listRecentByThreadId(threadId, limit);
  return transformRowsToPerception(dbMessages, opts);
}

/**
 * Transform already-loaded message rows into this agent's perception view.
 * Split from the row loading so the append-only
 * path can load its slice by offset and reuse the exact same classification
 * + XML wrapping + merge pipeline — wrapping stays deterministic per
 * (message, agent), which the cache prefix depends on.
 */
/**
 * Persisted injection: stable, set-once context (e.g. a project overview on an
 * empty thread) SAVED on the message row's metadata so it rides the cached
 * prefix, but stays hidden from the UI and out of search/embeddings (those read
 * `content`, never `metadata`).
 *
 * Cache discipline: WRITE-ONCE. A persisted injection is attached at message
 * creation and never edited afterward; editing it would change a message in the
 * middle of history and break the cached prefix from that point on. Only stable
 * content belongs here. Volatile/dynamic context stays in the unsaved tail
 * delta, never in metadata.
 */
export function effectiveContent(m: MessageRow, agentId?: string): string {
  const meta = m.metadata as Record<string, unknown> | null;
  let content = m.content;

  // Shared, agent-agnostic injection (e.g. project lineage). Folded for everyone.
  const injection = meta?.['persistedInjection'];
  if (typeof injection === 'string' && injection.length > 0) {
    content = content.length > 0 ? `${content}\n\n${injection}` : injection;
  }

  // Per-agent context pack (opening-message retrieval). Deterministic keyed
  // lookup so agent A only ever folds A's pack — adding B's pack later never
  // changes A's effective content, keeping A's cached prefix byte-identical.
  if (agentId) {
    const packs = meta?.['contextPacks'];
    const pack =
      packs && typeof packs === 'object' ? (packs as Record<string, unknown>)[agentId] : undefined;
    if (typeof pack === 'string' && pack.length > 0) {
      content = content.length > 0 ? `${content}\n\n${pack}` : pack;
    }
  }

  return content;
}

async function transformRowsToPerception(
  dbMessages: MessageRow[],
  opts: Omit<BuildPerceptionOpts, 'messageLimit' | 'threadId'>
): Promise<ProviderMessage[]> {
  const { agentId, isGroup, agentNameMap, agentRoleMap } = opts;

  const filtered = dbMessages.filter(
    (m: MessageRow) => m.role === 'user' || m.role === 'assistant'
  );

  // 1:1 chat — no XML, backwards compatible
  if (!isGroup) {
    const direct = filtered
      .filter((m: MessageRow) => effectiveContent(m, agentId).trim().length > 0)
      .map((m: MessageRow): TextMessage => {
        const content = effectiveContent(m, agentId);
        if (m.role === 'assistant' && m.agentId === agentId) {
          return { role: 'assistant', content };
        }
        return { role: 'user', content };
      });
    return resolveImageMarkers(direct);
  }

  // Group chat — XML perception layer
  const rawMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const m of filtered) {
    const type = classifyMessage(m, agentId, isGroup);
    const content = effectiveContent(m, agentId);

    switch (type) {
      case 'self': {
        // Own messages stay as plain assistant (skip empty)
        if (content.trim().length > 0) {
          rawMessages.push({ role: 'assistant', content });
        }
        break;
      }
      case 'human': {
        const xml = wrapXml('human', content, 'User');
        rawMessages.push({ role: 'user', content: xml });
        break;
      }
      case 'peer_speech': {
        const peerName = m.agentId ? agentNameMap.get(m.agentId) : undefined;
        const peerRole = m.agentId ? agentRoleMap?.get(m.agentId) : undefined;
        const filteredContent = filterPeerContent(content);
        const xml = wrapXml('peer_speech', filteredContent, peerName, peerRole);
        rawMessages.push({ role: 'user', content: xml });
        break;
      }
      default: {
        rawMessages.push({ role: 'user', content });
        break;
      }
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating roles)
  const merged = mergeConsecutiveRoles(rawMessages);
  return resolveImageMarkers(merged);
}

export const perceptionService = {
  buildPerception,
  transformRowsToPerception,

  // Exposed for testing
  escapeXml,
  classifyMessage,
  filterPeerContent,
  wrapXml,
  mergeConsecutiveRoles,
};
