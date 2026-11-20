import { parseMentions } from '../../../../../apps/server/src/services/MentionParser';

describe('parseMentions', () => {
  const agentMap = new Map<string, string>([
    ['agent-sam-001', 'sam'],
    ['agent-clio-002', 'Clio'],
    ['agent-rae-003', 'Rae Lin'],
  ]);

  describe('literal @mentions', () => {
    it('resolves exact handle match', () => {
      const result = parseMentions('hey @sam look at this', agentMap);
      expect(result.hasMentions).toBe(true);
      expect(result.mentionedAgentIds).toEqual(['agent-sam-001']);
    });

    it('is case-insensitive', () => {
      const result = parseMentions('@CLIO ping', agentMap);
      expect(result.mentionedAgentIds).toEqual(['agent-clio-002']);
    });

    it('resolves multi-word handle via underscore form', () => {
      const result = parseMentions('@rae_lin review please', agentMap);
      expect(result.mentionedAgentIds).toEqual(['agent-rae-003']);
    });

    it('resolves literal multi-word agent names', () => {
      const result = parseMentions('can you check this @Rae Lin', agentMap);
      expect(result.mentionedAgentIds).toEqual(['agent-rae-003']);
    });

    it('returns hasMentions:false when no mentions present', () => {
      const result = parseMentions('plain message no tags', agentMap);
      expect(result.hasMentions).toBe(false);
      expect(result.mentionedAgentIds).toEqual([]);
    });

    it('does not match @token mid-word (e.g. emails)', () => {
      const result = parseMentions('write to sam@example.com', agentMap);
      expect(result.hasMentions).toBe(false);
    });
  });

  describe('markdown-chip mentions (UI rich-text pills)', () => {
    it('resolves legacy angle-bracket mention markup', () => {
      const result = parseMentions('@sam<agent-sam-001> please look', agentMap);
      expect(result.hasMentions).toBe(true);
      expect(result.mentionedAgentIds).toEqual(['agent-sam-001']);
    });

    it('resolves a chip-form mention to the embedded agent ID', () => {
      const result = parseMentions('[sam](agent-sam-001) please look', agentMap);
      expect(result.hasMentions).toBe(true);
      expect(result.mentionedAgentIds).toEqual(['agent-sam-001']);
    });

    it('resolves multiple chip mentions in one message', () => {
      const result = parseMentions('[sam](agent-sam-001) and [Clio](agent-clio-002) FYI', agentMap);
      expect(result.hasMentions).toBe(true);
      expect(new Set(result.mentionedAgentIds)).toEqual(
        new Set(['agent-sam-001', 'agent-clio-002'])
      );
    });

    it('ignores chip mentions whose ID is not a participant', () => {
      const result = parseMentions('[ghost](agent-ghost-999) hello', agentMap);
      expect(result.hasMentions).toBe(false);
      expect(result.mentionedAgentIds).toEqual([]);
    });

    it('combines chip and literal mentions without duplicates', () => {
      const result = parseMentions('[sam](agent-sam-001) and @sam again', agentMap);
      expect(result.mentionedAgentIds).toEqual(['agent-sam-001']);
    });
  });

  describe('prefix-match fallback', () => {
    // Covers MentionParser.ts lines 130-134 — the startsWith() loop that
    // resolves a literal @token to an agent whose handle begins with that token,
    // once the token meets the minimum prefix length.

    it('resolves a prefix that uniquely identifies a handle', () => {
      // 'cli' is a prefix of 'clio' and matches no other agent.
      const result = parseMentions('@cli ping', agentMap);
      expect(result.hasMentions).toBe(true);
      expect(result.mentionedAgentIds).toEqual(['agent-clio-002']);
    });

    it('does not prefix-match tokens shorter than the minimum length', () => {
      // Single-char @s should not collapse onto 'sam' via the prefix branch.
      const result = parseMentions('@s hey', agentMap);
      expect(result.hasMentions).toBe(false);
      expect(result.mentionedAgentIds).toEqual([]);
    });

    it('does not resolve a prefix that matches no participant', () => {
      const result = parseMentions('@xyz nobody', agentMap);
      expect(result.hasMentions).toBe(false);
      expect(result.mentionedAgentIds).toEqual([]);
    });
  });
});
