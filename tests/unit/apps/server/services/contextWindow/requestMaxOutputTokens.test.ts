/**
 * The output limit a request carries: the catalog row's max output, lowered
 * only when the window cannot hold it on top of a prompt at the compaction
 * threshold, and none at all when the catalog does not know the limit (the
 * provider then applies its own maximum).
 */
import { requestMaxOutputTokens } from '@server/services/ContextWindowService';

const budget = (modelMaxOutputTokens: number | null, contextWindowTokens = 1_000_000) => ({
  modelMaxOutputTokens,
  contextWindowTokens,
  overheadTokens: 20_000,
  tokenThreshold: 600_000,
});

describe('requestMaxOutputTokens', () => {
  it('asks for the model’s whole max output', () => {
    expect(requestMaxOutputTokens(budget(128_000))).toBe(128_000);
  });

  it('asks for nothing when the catalog does not know the limit', () => {
    expect(requestMaxOutputTokens(budget(null))).toBeUndefined();
  });

  it('fits a max output that equals the window into what the window leaves', () => {
    expect(
      requestMaxOutputTokens({
        modelMaxOutputTokens: 131_072,
        contextWindowTokens: 131_072,
        overheadTokens: 4_000,
        tokenThreshold: 70_000,
      })
    ).toBe(57_072);
  });
});
