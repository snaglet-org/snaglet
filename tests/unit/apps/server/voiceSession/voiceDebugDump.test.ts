/**
 * voiceDebugDump — capture-audit stats + the off-by-default guarantee.
 * The dump path is env-gated (SNAGLET_VOICE_DEBUG_DUMP=1); with it unset the
 * module is a no-op and touches nothing.
 */

jest.mock('@server/services/LogsService', () => ({
  LogsService: { info: jest.fn(), warn: jest.fn() },
}));

import { describe, expect, it } from '@jest/globals';
import {
  computeCaptureStats,
  dumpUtteranceIfEnabled,
  isVoiceDebugDumpEnabled,
} from '@server/services/SocketService/voiceSession/voiceDebugDump';
import { LogsService } from '@server/services/LogsService';

describe('computeCaptureStats', () => {
  it('reports duration, peak, rms and clipping over pcm16', () => {
    // 16 samples @ 16 kHz = 1 ms. Peak = full-scale (clipping).
    const pcm = Int16Array.from([32767, -32767, 0, 0, 16384, -16384, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const s = computeCaptureStats(pcm, 16000);
    expect(s.durationMs).toBe(1);
    expect(s.peak).toBeCloseTo(32767 / 32768, 4);
    expect(s.rms).toBeGreaterThan(0);
    // Two of sixteen samples are at full-scale → clipping ratio 0.125.
    expect(s.clippingRatio).toBeCloseTo(0.125, 4);
  });

  it('is silence-safe (zero peak/rms, no clipping)', () => {
    const s = computeCaptureStats(new Int16Array(1600), 16000);
    expect(s.peak).toBe(0);
    expect(s.rms).toBe(0);
    expect(s.clippingRatio).toBe(0);
    expect(s.durationMs).toBe(100);
  });
});

describe('dump gating (off by default)', () => {
  it('is disabled unless SNAGLET_VOICE_DEBUG_DUMP=1', () => {
    expect(isVoiceDebugDumpEnabled()).toBe(false);
  });

  it('no-ops (writes nothing, logs nothing) when disabled', () => {
    dumpUtteranceIfEnabled('session-1', Int16Array.from([1, 2, 3, 4]));
    expect(LogsService.info).not.toHaveBeenCalled();
    expect(LogsService.warn).not.toHaveBeenCalled();
  });
});
