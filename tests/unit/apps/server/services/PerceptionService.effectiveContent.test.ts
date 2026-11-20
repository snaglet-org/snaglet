import { describe, expect, it } from '@jest/globals';
import { effectiveContent } from '@server/services/PerceptionService';
import type { MessageRow } from '@snaglet/db/tables/messages';

function row(partial: Partial<MessageRow>): MessageRow {
  return { content: '', metadata: null, ...partial } as unknown as MessageRow;
}

describe('effectiveContent — per-agent context pack fold', () => {
  const m = row({
    content: 'hello',
    metadata: {
      persistedInjection: 'PROJECT_LINEAGE',
      contextPacks: { 'agent-A': 'PACK_A', 'agent-B': 'PACK_B' },
    },
  });

  it("folds only the requested agent's pack, plus the shared injection", () => {
    const a = effectiveContent(m, 'agent-A');
    expect(a).toContain('hello');
    expect(a).toContain('PROJECT_LINEAGE');
    expect(a).toContain('PACK_A');
    expect(a).not.toContain('PACK_B'); // never sees another agent's pack
  });

  it("is byte-identical for agent A whether or not B's pack exists (cache-safe)", () => {
    const withB = row({
      content: 'hello',
      metadata: { contextPacks: { 'agent-A': 'PACK_A', 'agent-B': 'PACK_B' } },
    });
    const withoutB = row({
      content: 'hello',
      metadata: { contextPacks: { 'agent-A': 'PACK_A' } },
    });
    // Adding B's pack later must not change A's perceived content → prefix stays
    // byte-identical → prompt cache survives.
    expect(effectiveContent(withB, 'agent-A')).toBe(effectiveContent(withoutB, 'agent-A'));
  });

  it('folds no pack when no agentId is given (shared injection still applies)', () => {
    const out = effectiveContent(m);
    expect(out).toContain('PROJECT_LINEAGE');
    expect(out).not.toContain('PACK_A');
  });

  it('returns raw content when there is no metadata', () => {
    expect(effectiveContent(row({ content: 'plain' }), 'agent-A')).toBe('plain');
  });
});
