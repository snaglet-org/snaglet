const RIPGREP_VERSION = '14.1.1';

// SHA-256 of each official ripgrep 14.1.1 release archive, pinned in the repo
// so a build only accepts the exact archives that were vetted. Values come
// from the release's own `<archive>.sha256` files at
// https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1. Changing
// RIPGREP_VERSION requires re-pinning every entry.
// 14.1.1 publishes no x86_64-unknown-linux-gnu archive; the static musl build
// is the official x86_64 Linux binary.
const RIPGREP_ARCHIVE_SHA256 = Object.freeze({
  'aarch64-apple-darwin': '24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be',
  'x86_64-apple-darwin': 'fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3',
  'aarch64-unknown-linux-gnu': 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f',
  'x86_64-unknown-linux-musl': '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e',
  'x86_64-pc-windows-msvc': 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1',
});

function ripgrepTarget(platform, arch) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64'))
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-musl';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported ripgrep platform/architecture: ${platform}/${arch}`);
}

function pinnedRipgrepArchiveSha256(target) {
  const pinned = Object.prototype.hasOwnProperty.call(RIPGREP_ARCHIVE_SHA256, target)
    ? RIPGREP_ARCHIVE_SHA256[target]
    : undefined;
  if (!pinned) throw new Error(`no pinned ripgrep ${RIPGREP_VERSION} checksum for ${target}`);
  return pinned;
}

module.exports = {
  RIPGREP_VERSION,
  RIPGREP_ARCHIVE_SHA256,
  pinnedRipgrepArchiveSha256,
  ripgrepTarget,
};
