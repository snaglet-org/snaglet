import { describe, expect, it } from 'vitest';
import { chipHrefForNode, nodeToChipMarkdown } from '@desktop/utils/nodeChip';
import { PREFIXED_KINDS, parseNodeRef } from './nodeRef';

describe('model chips', () => {
  it('preserves provider model ids containing slashes and colons', () => {
    const chip = {
      id: 'anthropic/claude-sonnet-4:latest',
      kind: 'model' as const,
      title: 'Claude Sonnet',
    };

    expect(chipHrefForNode(chip)).toBe('model:anthropic/claude-sonnet-4:latest');
    expect(parseNodeRef(chipHrefForNode(chip))).toEqual({
      kind: 'model',
      id: 'anthropic/claude-sonnet-4:latest',
    });
    expect(nodeToChipMarkdown(chip)).toBe(
      '[Claude Sonnet](model:anthropic/claude-sonnet-4:latest)'
    );
  });

  it('rejects empty or whitespace-bearing model references', () => {
    expect(parseNodeRef('model:')).toBeNull();
    expect(parseNodeRef('model:not a model')).toBeNull();
  });
});

describe('run chips', () => {
  // Run ids are bare randomUUID()s (turnLoop.ts) — no `run-` prefix — so the
  // `run:<uuid>` scheme is the only grammar a run chip can take.
  const RUN_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

  it('survives the markdown round-trip instead of degrading to a plain link', () => {
    const chip = { id: RUN_ID, kind: 'run' as const, title: 'mango' };

    const href = chipHrefForNode(chip);
    expect(href).toBe(`run:${RUN_ID}`);
    expect(nodeToChipMarkdown(chip)).toBe(`[mango](run:${RUN_ID})`);

    // A null here would bring a saved chip back as an ordinary link after
    // reload.
    expect(parseNodeRef(href)).toEqual({ kind: 'run', id: RUN_ID });
  });

  it('rejects malformed run references', () => {
    expect(parseNodeRef('run:')).toBeNull();
    expect(parseNodeRef('run:not-a-uuid')).toBeNull();
    // No `run-` prefixed-id grammar exists — nothing emits that shape, and
    // bare `run-…` text must not auto-link into a pill.
    expect(parseNodeRef(`run-${RUN_ID}`)).toBeNull();
  });

  it('is absent from the prefixed-id vocabulary that drives bare-id autolinking', () => {
    expect(PREFIXED_KINDS as readonly string[]).not.toContain('run');
  });
});
