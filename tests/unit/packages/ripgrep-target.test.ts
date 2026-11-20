import {
  RIPGREP_ARCHIVE_SHA256,
  pinnedRipgrepArchiveSha256,
  ripgrepTarget,
} from '../../../apps/desktop/scripts/ripgrep-target.cjs';

const SUPPORTED: Array<[string, string, string]> = [
  ['darwin', 'arm64', 'aarch64-apple-darwin'],
  ['darwin', 'x64', 'x86_64-apple-darwin'],
  ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
  // 14.1.1 ships no x86_64-unknown-linux-gnu archive; musl is the official x64 Linux build.
  ['linux', 'x64', 'x86_64-unknown-linux-musl'],
  ['win32', 'x64', 'x86_64-pc-windows-msvc'],
];

describe('ripgrepTarget', () => {
  test.each(SUPPORTED)('maps %s/%s to the official release target', (platform, arch, target) => {
    expect(ripgrepTarget(platform, arch)).toBe(target);
  });
  test('rejects unsupported architectures instead of silently selecting x64', () => {
    expect(() => ripgrepTarget('linux', 'ia32')).toThrow(
      'unsupported ripgrep platform/architecture'
    );
  });
});

describe('pinned ripgrep archive checksums', () => {
  test('pins exactly one SHA-256 for every supported target and nothing else', () => {
    expect(Object.keys(RIPGREP_ARCHIVE_SHA256).sort()).toEqual(
      SUPPORTED.map(([, , target]) => target).sort()
    );
    for (const [, , target] of SUPPORTED) {
      expect(pinnedRipgrepArchiveSha256(target)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  test('refuses a target without a pinned checksum', () => {
    expect(() => pinnedRipgrepArchiveSha256('x86_64-unknown-linux-gnu')).toThrow(
      'no pinned ripgrep'
    );
    expect(() => pinnedRipgrepArchiveSha256('toString')).toThrow('no pinned ripgrep');
  });
});
