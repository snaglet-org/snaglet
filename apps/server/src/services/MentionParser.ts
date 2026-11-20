/**
 * MentionParser — extracts @mentions from user messages and resolves them to agent IDs.
 *
 * Used by chatHandlers to determine which agents should be dispatched for a group message.
 * Reuses the handle-building pattern from SocialService for consistent mention resolution.
 */

import { escapeRegex } from '@snaglet/shared/utils';

export interface MentionResult {
  /** Agent IDs that were @mentioned and resolved successfully */
  mentionedAgentIds: string[];
  /** True if any valid @mentions were found */
  hasMentions: boolean;
  /** The raw @tokens extracted (for logging) */
  rawMentions: string[];
}

/**
 * Build all plausible handle forms for an agent name.
 * e.g. "Ada Chen" → ["ada chen", "ada_chen", "ada-chen", "adachen"]
 */
function buildHandles(name: string): string[] {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return [];

  const handles = new Set<string>([trimmed]);
  handles.add(trimmed.replace(/\s+/g, '_'));
  handles.add(trimmed.replace(/\s+/g, '-'));
  handles.add(trimmed.replace(/\s+/g, ''));

  return [...handles].filter(Boolean);
}

/**
 * Extract raw @mention tokens from a message string.
 * Matches `@patty`, `@ada_chen`, `@Clio`, etc.
 */
function extractMentionTokens(text: string): string[] {
  const tokens = new Set<string>();
  const regex = /(^|[^\w])@([a-z0-9][a-z0-9._-]{0,63})/gi;
  let match: RegExpExecArray | null = regex.exec(text);

  while (match) {
    const token = match[2]?.trim().toLowerCase();
    if (token) tokens.add(token);
    match = regex.exec(text);
  }

  return [...tokens];
}

function extractExactAgentMentionIds(text: string, agentNameMap: Map<string, string>): string[] {
  const ids = new Set<string>();
  const candidates: Array<{ handle: string; agentId: string }> = [];

  for (const [agentId, name] of agentNameMap) {
    for (const handle of buildHandles(name)) {
      candidates.push({ handle, agentId });
    }
  }

  candidates.sort((a, b) => b.handle.length - a.handle.length);

  for (const { handle, agentId } of candidates) {
    if (!handle) continue;
    const re = new RegExp(`(^|[^\\w])@${escapeRegex(handle)}(?=$|[\\s.,!?;:()[\\]{}"'\\n])`, 'i');
    if (re.test(text)) ids.add(agentId);
  }

  return [...ids];
}

/**
 * Extract agent IDs from explicit chip mentions.
 *
 * Chip formats (still present in stored messages): `@name<agent-1234-abc>`
 * and `[name](agent-1234-abc)`.
 *
 * Both render as rich-text mention pills, not as plain `@name` text. The
 * `@token` regex above is intentionally not enough because it only sees a
 * display label; the embedded ID is the routing identity.
 *
 * Returned IDs are not yet validated against the thread's participants —
 * the caller filters them by `agentNameMap` so a chip pointing at a
 * non-participant can't escalate into a dispatch.
 */
function extractChipMentionIds(text: string): string[] {
  const ids = new Set<string>();
  // @label<agent-<id>> — id is non-whitespace and ends at the closing angle.
  const mentionRegex = /@([^<>\n]{1,120})<(agent-[^>\s]+)>/g;
  let match: RegExpExecArray | null = mentionRegex.exec(text);
  while (match) {
    const id = match[2]?.trim();
    if (id) ids.add(id);
    match = mentionRegex.exec(text);
  }

  // [link text](agent-<id>) — id is non-whitespace, non-paren, non-bracket.
  const markdownRegex = /\[[^\]]+\]\((agent-[^)\s\]]+)\)/g;
  match = markdownRegex.exec(text);
  while (match) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
    match = markdownRegex.exec(text);
  }

  return [...ids];
}

/**
 * Parse @mentions from a user message and resolve them to agent IDs.
 *
 * @param message  The raw user message text
 * @param agentNameMap  Map of agentId → agent name (all participants in the thread)
 * @param minPrefixChars  Minimum chars for prefix matching (default 3)
 */
export function parseMentions(
  message: string,
  agentNameMap: Map<string, string>,
  minPrefixChars: number = 3
): MentionResult {
  const rawMentions = extractMentionTokens(message);
  const chipMentionIds = extractChipMentionIds(message);
  const exactMentionIds = extractExactAgentMentionIds(message, agentNameMap);

  if (rawMentions.length === 0 && chipMentionIds.length === 0 && exactMentionIds.length === 0) {
    return { mentionedAgentIds: [], hasMentions: false, rawMentions: [] };
  }

  const resolved = new Set<string>();

  // 0. Markdown-chip mentions: trust the embedded agent ID, but only if
  //    the agent is actually a participant of this thread (agentNameMap).
  for (const id of chipMentionIds) {
    if (agentNameMap.has(id)) {
      resolved.add(id);
    }
  }

  for (const id of exactMentionIds) {
    resolved.add(id);
  }

  // Build a lookup: handle → agentId (multiple handles per agent)
  const handleToAgentId = new Map<string, string>();
  for (const [agentId, name] of agentNameMap) {
    for (const handle of buildHandles(name)) {
      handleToAgentId.set(handle, agentId);
    }
  }

  for (const token of rawMentions) {
    // 1. Exact match against any handle form
    const exactMatch = handleToAgentId.get(token);
    if (exactMatch) {
      resolved.add(exactMatch);
      continue;
    }

    // 2. Prefix match (e.g. @pat → Patty) — minimum minPrefixChars chars
    if (token.length >= minPrefixChars) {
      for (const [handle, agentId] of handleToAgentId) {
        if (handle.startsWith(token)) {
          resolved.add(agentId);
          break; // first prefix match wins
        }
      }
    }
  }

  return {
    mentionedAgentIds: [...resolved],
    hasMentions: resolved.size > 0,
    rawMentions,
  };
}
