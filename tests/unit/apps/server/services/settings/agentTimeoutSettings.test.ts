import { describe, it, expect } from '@jest/globals';
import { agentSettings } from '@server/services/settings/categories/agent';

/**
 * Agent turns have no wall-clock limit by default; a hung model call is
 * caught by the stream-idle watchdog instead. 0 means "no limit" for both.
 */
describe('agent timeout settings', () => {
  it('timeout_seconds defaults to 0 (unlimited)', () => {
    expect(agentSettings.timeoutSeconds.key).toBe('timeout_seconds');
    expect(agentSettings.timeoutSeconds.default).toBe(0);
  });

  it('timeout_seconds accepts 0 and positive ints, rejects negatives and fractions', () => {
    const s = agentSettings.timeoutSeconds.schema;
    expect(s.safeParse(0).success).toBe(true);
    expect(s.safeParse(600).success).toBe(true);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(1.5).success).toBe(false);
  });

  it('stream_idle_timeout_seconds defaults to 300 and accepts 0 (off)', () => {
    const def = agentSettings.streamIdleTimeoutSeconds;
    expect(def.key).toBe('stream_idle_timeout_seconds');
    expect(def.default).toBe(300);
    expect(def.schema.safeParse(0).success).toBe(true);
    expect(def.schema.safeParse(-5).success).toBe(false);
  });
});
