import type { SnagletAgent } from '@snaglet/shared/types';
import { escapeRegex } from '@snaglet/shared/utils';

const LEGACY_AGENT_MENTION_RE = /@([^<>\n]{1,120})<(agent-[^>\s]+)>/g;
type AgentLike = Pick<SnagletAgent, 'id' | 'name'>;

export interface AgentMentionToken {
  start: number;
  end: number;
  title: string;
  href: string;
}

function mentionBoundarySource(): string {
  return `(?=$|[\\s.,!?;:()[\\]{}"'\\n])`;
}

export function agentLookupHandle(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

function sanitizeAgentMentionLabel(title: string): string {
  return (
    title
      .replace(/[<>\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Agent'
  );
}

export function agentMentionMarkdown(title: string): string {
  return `@${sanitizeAgentMentionLabel(title)}`;
}

export function appendSelectedAgentMentions(text: string, selectedAgents: AgentLike[]): string {
  if (selectedAgents.length === 0) return text;

  const existingMentionedAgentIds = new Set(
    findAgentMentionTokens(text, selectedAgents).map((token) => token.href)
  );
  const appendedAgentIds = new Set<string>();
  const mentions = selectedAgents
    .filter((agent) => {
      if (appendedAgentIds.has(agent.id) || existingMentionedAgentIds.has(agent.id)) {
        return false;
      }
      appendedAgentIds.add(agent.id);
      return true;
    })
    .map((agent) => agentMentionMarkdown(agent.name));

  if (mentions.length === 0) return text;
  return `${text}${text.length > 0 ? ' ' : ''}${mentions.join(' ')}`;
}

export function findAgentMentionTokens(
  value: string,
  agents: AgentLike[] | null
): AgentMentionToken[] {
  const tokens: AgentMentionToken[] = [];

  LEGACY_AGENT_MENTION_RE.lastIndex = 0;
  let legacyMatch: RegExpExecArray | null;
  while ((legacyMatch = LEGACY_AGENT_MENTION_RE.exec(value))) {
    const [, title, href] = legacyMatch;
    tokens.push({
      start: legacyMatch.index,
      end: legacyMatch.index + legacyMatch[0].length,
      title: sanitizeAgentMentionLabel(title),
      href,
    });
  }

  if (!agents || agents.length === 0) {
    return tokens.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  }

  const candidates = agents
    .flatMap((agent) => {
      const name = sanitizeAgentMentionLabel(agent.name);
      const handle = agentLookupHandle(name);
      return [
        { text: name, title: name, href: agent.id },
        handle && handle !== name.toLowerCase()
          ? { text: handle, title: name, href: agent.id }
          : null,
      ].filter(Boolean) as Array<{ text: string; title: string; href: string }>;
    })
    .sort((a, b) => b.text.length - a.text.length);

  const occupied = (start: number, end: number) =>
    tokens.some((token) => start < token.end && end > token.start);

  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const re = new RegExp(
      `(^|[^\\w])@(${escapeRegex(candidate.text)})${mentionBoundarySource()}`,
      'gi'
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(value))) {
      const prefixLength = match[1]?.length ?? 0;
      const start = match.index + prefixLength;
      const end = start + 1 + match[2].length;
      if (occupied(start, end)) continue;
      tokens.push({ start, end, title: candidate.title, href: candidate.href });
    }
  }

  return tokens.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
}

export function agentMentionsToMarkdownLinksWithAgents(
  value: string,
  agents: AgentLike[] | null
): string {
  const tokens = findAgentMentionTokens(value, agents);
  if (tokens.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) continue;
    out += value.slice(cursor, token.start);
    const safeTitle = token.title.replace(/[\]\\]/g, '\\$&').trim() || 'Agent';
    out += `[${safeTitle}](${token.href})`;
    cursor = token.end;
  }
  return out + value.slice(cursor);
}
