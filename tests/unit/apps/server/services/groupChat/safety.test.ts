import {
  DEFAULT_MAX_OUTPUT_TOKENS_CEILING,
  DEFAULT_MAX_WAVES_CEILING,
  MAX_AGENTS_PER_MESSAGE,
  clampToCeiling,
  resolveMaxOutputTokensCeiling,
  resolveMaxWavesCeiling,
  validateMentionFanOut,
} from '@server/services/groupChat/safety';

describe('groupChat/safety — governance constants', () => {
  it('server ceilings carry the documented defaults', () => {
    // Both the test and the constants encode the same product contract.
    // If this fails, investigate whether the implementation or the
    // contract moved.
    expect(DEFAULT_MAX_WAVES_CEILING).toBe(24);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_CEILING).toBe(192_000);
  });

  it('MAX_AGENTS_PER_MESSAGE is the documented cap', () => {
    expect(MAX_AGENTS_PER_MESSAGE).toBe(4);
  });
});

describe('ceiling env resolution', () => {
  const ENV_VARS = ['SNAGLET_MAX_WAVES_CEILING', 'SNAGLET_MAX_OUTPUT_TOKENS_CEILING'] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const v of ENV_VARS) saved.set(v, process.env[v]);
  });
  afterEach(() => {
    for (const v of ENV_VARS) {
      const prior = saved.get(v);
      if (prior === undefined) delete process.env[v];
      else process.env[v] = prior;
    }
  });

  it('defaults apply when the env vars are unset', () => {
    for (const v of ENV_VARS) delete process.env[v];
    expect(resolveMaxWavesCeiling()).toBe(DEFAULT_MAX_WAVES_CEILING);
    expect(resolveMaxOutputTokensCeiling()).toBe(DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
  });

  it('valid env overrides are honored', () => {
    process.env.SNAGLET_MAX_WAVES_CEILING = '48';
    process.env.SNAGLET_MAX_OUTPUT_TOKENS_CEILING = '500000';
    expect(resolveMaxWavesCeiling()).toBe(48);
    expect(resolveMaxOutputTokensCeiling()).toBe(500_000);
  });

  it('garbage / non-positive env values fall back to the defaults', () => {
    process.env.SNAGLET_MAX_WAVES_CEILING = 'unlimited';
    process.env.SNAGLET_MAX_OUTPUT_TOKENS_CEILING = '0';
    expect(resolveMaxWavesCeiling()).toBe(DEFAULT_MAX_WAVES_CEILING);
    expect(resolveMaxOutputTokensCeiling()).toBe(DEFAULT_MAX_OUTPUT_TOKENS_CEILING);
  });
});

describe('clampToCeiling', () => {
  // maxWaves is not a valid field — waves are
  // never clamped to a server ceiling. Only maxTotalOutputTokens uses this.
  it('passes through values at or under the ceiling', () => {
    expect(clampToCeiling('maxTotalOutputTokens', 100_000, 192_000)).toBe(100_000);
    expect(clampToCeiling('maxTotalOutputTokens', 192_000, 192_000)).toBe(192_000);
  });

  it('clamps values over the ceiling', () => {
    expect(clampToCeiling('maxTotalOutputTokens', 1_000_000, 192_000)).toBe(192_000);
  });
});

describe('validateMentionFanOut', () => {
  it('returns null when no agents are mentioned', () => {
    expect(validateMentionFanOut([])).toBeNull();
  });

  it('returns null at the cap', () => {
    const ids = Array.from({ length: MAX_AGENTS_PER_MESSAGE }, (_, i) => `agent-${i}`);
    expect(validateMentionFanOut(ids)).toBeNull();
  });

  it('rejects when over the cap', () => {
    const ids = Array.from({ length: MAX_AGENTS_PER_MESSAGE + 1 }, (_, i) => `agent-${i}`);
    const err = validateMentionFanOut(ids);
    expect(err).not.toBeNull();
    // Error message should include both the actual count and the limit so the
    // user can see exactly how far over they were.
    expect(err).toContain(String(MAX_AGENTS_PER_MESSAGE + 1));
    expect(err).toContain(String(MAX_AGENTS_PER_MESSAGE));
  });

  it('rejects significantly over the cap', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    expect(validateMentionFanOut(ids)).not.toBeNull();
  });
});
