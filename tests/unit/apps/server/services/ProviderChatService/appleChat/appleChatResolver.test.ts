/**
 * appleChatResolver — the pure `decideAppleChatAvailability` covers the
 * platform × buildability × live-probe matrix (mirrors sttEngineResolver's
 * `decideSttEngine` test shape): non-darwin always hides the provider
 * regardless of anything else, darwin-but-unbuildable/unavailable disables it
 * with the honest reason, darwin+available enables it.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import {
  appleChatBinaryPath,
  appleChatSidecarBundled,
  decideAppleChatAvailability,
} from '@server/services/ProviderChatService/appleChat/appleChatResolver';

describe('decideAppleChatAvailability — platform × buildability × probe', () => {
  it('non-darwin → hidden, regardless of buildability or probe', () => {
    expect(
      decideAppleChatAvailability({
        platform: 'linux',
        binaryBuildable: true,
        probe: { available: true },
      })
    ).toEqual({ available: false, reason: 'nonDarwin' });

    expect(decideAppleChatAvailability({ platform: 'win32', binaryBuildable: false })).toEqual({
      available: false,
      reason: 'nonDarwin',
    });
  });

  it('darwin + binary not buildable → disabled, reason binaryUnbuildable', () => {
    expect(decideAppleChatAvailability({ platform: 'darwin', binaryBuildable: false })).toEqual({
      available: false,
      reason: 'binaryUnbuildable',
    });
  });

  it('darwin + binary not buildable + never bundled → disabled, reason notBundled', () => {
    // A packaged app whose release skipped the best-effort apple-chat helper
    // ships neither the binary nor build.sh: that is a known packaging
    // outcome, not a compiler problem, and the gate must say so.
    expect(
      decideAppleChatAvailability({ platform: 'darwin', binaryBuildable: false, bundled: false })
    ).toEqual({ available: false, reason: 'notBundled' });
    // Source present but unbuildable keeps the compiler-oriented reason.
    expect(
      decideAppleChatAvailability({ platform: 'darwin', binaryBuildable: false, bundled: true })
    ).toEqual({ available: false, reason: 'binaryUnbuildable' });
    // A bundled-but-unbuildable check never overrides the platform rule.
    expect(
      decideAppleChatAvailability({ platform: 'linux', binaryBuildable: false, bundled: false })
    ).toEqual({ available: false, reason: 'nonDarwin' });
  });

  it('darwin + buildable + probe available → enabled', () => {
    expect(
      decideAppleChatAvailability({
        platform: 'darwin',
        binaryBuildable: true,
        probe: { available: true },
      })
    ).toEqual({ available: true });
  });

  it.each([
    'deviceNotEligible',
    'appleIntelligenceNotEnabled',
    'modelNotReady',
    'frameworkUnavailable',
  ])(
    'darwin + buildable + probe unavailable(%s) → disabled with the SAME honest reason',
    (reason) => {
      expect(
        decideAppleChatAvailability({
          platform: 'darwin',
          binaryBuildable: true,
          probe: { available: false, reason },
        })
      ).toEqual({ available: false, reason });
    }
  );

  it('an unrecognized sidecar reason normalizes to "unknown" rather than passing through garbage', () => {
    expect(
      decideAppleChatAvailability({
        platform: 'darwin',
        binaryBuildable: true,
        probe: { available: false, reason: 'someFutureSwiftEnumCase' },
      })
    ).toEqual({ available: false, reason: 'unknown' });
  });

  it('darwin + buildable but no probe ran → disabled, reason unknown (defensive)', () => {
    expect(
      decideAppleChatAvailability({ platform: 'darwin', binaryBuildable: true, probe: null })
    ).toEqual({ available: false, reason: 'unknown' });
  });
});

describe('appleChatBinaryPath — SNAGLET_APPLE_CHAT_BIN override', () => {
  const prior = process.env.SNAGLET_APPLE_CHAT_BIN;
  afterEach(() => {
    if (prior === undefined) delete process.env.SNAGLET_APPLE_CHAT_BIN;
    else process.env.SNAGLET_APPLE_CHAT_BIN = prior;
  });

  it('honors SNAGLET_APPLE_CHAT_BIN when set', () => {
    process.env.SNAGLET_APPLE_CHAT_BIN = '/tmp/fake-snaglet-apple-chat';
    expect(appleChatBinaryPath()).toBe('/tmp/fake-snaglet-apple-chat');
  });

  it('falls back to the sidecar bin/ path when unset', () => {
    delete process.env.SNAGLET_APPLE_CHAT_BIN;
    expect(appleChatBinaryPath()).toMatch(/native[\\/]apple-chat[\\/]bin[\\/]snaglet-apple-chat$/);
  });
});

describe('appleChatSidecarBundled — source checkout vs packaged bundle', () => {
  const prior = process.env.SNAGLET_APPLE_CHAT_BIN;
  afterEach(() => {
    if (prior === undefined) delete process.env.SNAGLET_APPLE_CHAT_BIN;
    else process.env.SNAGLET_APPLE_CHAT_BIN = prior;
  });

  it('is true in a source checkout even when the binary is missing (build.sh is present)', () => {
    process.env.SNAGLET_APPLE_CHAT_BIN = '/nonexistent/snaglet-apple-chat';
    expect(appleChatSidecarBundled()).toBe(true);
  });
});
