/**
 * Real-hardware round trip against the compiled snaglet-apple-chat sidecar and
 * Apple's FoundationModels framework. Env-gated (`SNAGLET_APPLE_CHAT=1`) and
 * darwin-only, so it never runs in CI; appleChatEngine.test.ts covers the
 * engine logic against a fake sidecar.
 *
 * Run locally on a macOS 26 machine with Apple Intelligence enabled:
 *   SNAGLET_APPLE_CHAT=1 npx jest appleChatEngine.realHardware
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it } from '@jest/globals';
import { AppleChatEngine } from '@server/services/ProviderChatService/appleChat/appleChatEngine';
import {
  ensureAppleChatBinary,
  appleChatBinaryPath,
} from '@server/services/ProviderChatService/appleChat/appleChatResolver';

const REAL_HARDWARE = process.env.SNAGLET_APPLE_CHAT === '1' && process.platform === 'darwin';
const describeRealHardware = REAL_HARDWARE ? describe : describe.skip;

describeRealHardware(
  'AppleChatEngine — REAL FoundationModels sidecar (SNAGLET_APPLE_CHAT=1, darwin only)',
  () => {
    it('builds (or finds) the sidecar binary and runs a live availability probe', async () => {
      const bin = ensureAppleChatBinary();
      expect(bin).toBe(appleChatBinaryPath());
      const engine = new AppleChatEngine({ command: bin! });
      const availability = await engine.checkAvailability();
      expect(typeof availability.available).toBe('boolean');
      await engine.shutdown();
    }, 60_000);

    it('streams a real chat reply end-to-end (skips assertions if this Mac genuinely cannot generate right now)', async () => {
      const bin = ensureAppleChatBinary();
      const engine = new AppleChatEngine({ command: bin! });
      const availability = await engine.checkAvailability();
      if (!availability.available) {
        // Buildable but not currently usable (Apple Intelligence off, model
        // still downloading, ineligible device, …) — nothing more to prove.
        await engine.shutdown();
        return;
      }

      const chunks: string[] = [];
      const result = await engine.chat({
        sessionKey: 'real-hardware-test',
        prompt: 'Reply with exactly one word: acknowledged',
        instructions: 'You are terse and follow instructions exactly.',
        onChunk: (t) => chunks.push(t),
      });

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.stopReason).toBe('end_turn');
      // Every onChunk delta concatenated must equal the final assembled text
      // — this is the snapshot-diff correctness property, proven here against
      // the real framework, not a fake.
      expect(chunks.join('')).toBe(result.text);
      await engine.shutdown();
    }, 60_000);
  }
);
