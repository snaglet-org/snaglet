const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { RIPGREP_VERSION, pinnedRipgrepArchiveSha256 } = require('./ripgrep-target.cjs');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function validateRipgrepCache(
  binary,
  license,
  metadata,
  expectedVersion = RIPGREP_VERSION,
  expectedTarget = 'aarch64-apple-darwin'
) {
  if (
    !metadata ||
    metadata.ripgrepVersion !== expectedVersion ||
    metadata.target !== expectedTarget ||
    // A cache built from any archive other than the pinned one is discarded.
    metadata.archiveSha256 !== pinnedRipgrepArchiveSha256(expectedTarget)
  )
    throw new Error('cached ripgrep metadata failed validation');
  if (!existsSync(license)) throw new Error('cached ripgrep license is missing');
  if (metadata.binarySha256 !== sha256(binary) || metadata.licenseSha256 !== sha256(license))
    throw new Error('cached ripgrep integrity verification failed');
  return metadata;
}

module.exports = { validateRipgrepCache };
