import { describe, expect, it } from 'vitest';
import { isSemanticBuilding, semanticStatusLine, type SemanticSwitchState } from './semanticSearch';

function state(overrides: Partial<SemanticSwitchState> = {}): SemanticSwitchState {
  return {
    tableId: 'table-1111111111111-aaaaaaaaa',
    enabled: true,
    rows: 1,
    rowsCapped: false,
    needsConfirmation: false,
    indexed: 1,
    state: 'ready',
    estimate: { rows: 1, bytes: 4_400, label: '~4 KB' },
    ...overrides,
  };
}

describe('semanticStatusLine', () => {
  it('reads rows indexed and size, in the singular for one row', () => {
    expect(semanticStatusLine(state())).toBe('1 of 1 row indexed · ~4 KB');
  });

  it('marks a count past the ceiling with a plus', () => {
    expect(
      semanticStatusLine(
        state({
          enabled: false,
          state: 'off',
          indexed: 0,
          rows: 100_000,
          rowsCapped: true,
          needsConfirmation: true,
          estimate: { rows: 100_000, bytes: 440_000_000, label: '~420 MB' },
        })
      )
    ).toBe('Off · 100,000+ rows, more than the 10,000 indexed automatically (~420 MB)');
  });

  it('is building only while on, indexing and not paused', () => {
    expect(isSemanticBuilding(state({ state: 'indexing' }))).toBe(true);
    expect(isSemanticBuilding(state({ state: 'indexing', paused: 'off' }))).toBe(false);
    expect(isSemanticBuilding(state({ state: 'ready' }))).toBe(false);
    expect(isSemanticBuilding(state({ enabled: false, state: 'off' }))).toBe(false);
  });
});
