import { describe, it, expect } from '@jest/globals';
import { toolSettings } from '@server/services/settings/categories/tool';

/**
 * Locks the agent-efficiency setting defaults the condenser + repeat guard were
 * tuned against, so a silent change to any of them fails here instead of
 * quietly changing agent behavior.
 */
describe('tool category setting defaults', () => {
  it('maxIterations default is data-derived (~1.5× the largest observed run)', () => {
    expect(toolSettings.maxIterations.default).toBe(640);
  });

  it('condenseMinChars floor keeps small results whole', () => {
    expect(toolSettings.condenseMinChars.default).toBe(1500);
  });

  it('maxResultChars ingest ceiling caps mega-outputs at head+tail', () => {
    expect(toolSettings.maxResultChars.default).toBe(12000);
  });

  it('toolBulkTokenBudget is a fixed token budget (not a %-of-window)', () => {
    expect(toolSettings.toolBulkTokenBudget.default).toBe(35000);
  });
});
