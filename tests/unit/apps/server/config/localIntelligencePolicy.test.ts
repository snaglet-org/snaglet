import { describe, expect, it } from '@jest/globals';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';

describe('automatic local intelligence policy', () => {
  it('is disabled by default', () => {
    expect(isAutomaticLocalIntelligenceEnabled({})).toBe(false);
  });

  it('requires an explicit true opt-in', () => {
    expect(isAutomaticLocalIntelligenceEnabled({ SNAGLET_LOCAL_INTELLIGENCE: 'true' })).toBe(true);
    expect(isAutomaticLocalIntelligenceEnabled({ SNAGLET_LOCAL_INTELLIGENCE: ' TRUE ' })).toBe(
      true
    );
    expect(isAutomaticLocalIntelligenceEnabled({ SNAGLET_LOCAL_INTELLIGENCE: 'false' })).toBe(
      false
    );
    expect(isAutomaticLocalIntelligenceEnabled({ SNAGLET_LOCAL_INTELLIGENCE: '1' })).toBe(false);
  });
});
