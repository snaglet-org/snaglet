import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRipgrepCache } from '../../../apps/desktop/scripts/ripgrep-stage.cjs';
import { pinnedRipgrepArchiveSha256 } from '../../../apps/desktop/scripts/ripgrep-target.cjs';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('validateRipgrepCache', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rg stage spaces '));
    const binary = path.join(root, 'rg');
    const license = path.join(root, 'LICENSE-MIT');
    writeFileSync(binary, 'binary');
    writeFileSync(license, 'MIT permission text');
    return {
      root,
      binary,
      license,
      metadata: {
        archiveSha256: pinnedRipgrepArchiveSha256('aarch64-apple-darwin'),
        binarySha256: digest('binary'),
        licenseSha256: digest('MIT permission text'),
        ripgrepVersion: '14.1.1',
        target: 'aarch64-apple-darwin',
      },
    };
  };
  test('accepts a fresh cache with matching executable and full-license hashes', () => {
    const value = setup();
    expect(validateRipgrepCache(value.binary, value.license, value.metadata)).toEqual(
      value.metadata
    );
  });
  test.each([
    ['tampered binary', (v: ReturnType<typeof setup>) => writeFileSync(v.binary, 'tampered')],
    ['tampered license', (v: ReturnType<typeof setup>) => writeFileSync(v.license, 'bad')],
  ])('rejects %s', (_name, mutate) => {
    const value = setup();
    mutate(value);
    expect(() => validateRipgrepCache(value.binary, value.license, value.metadata)).toThrow(
      /integrity/
    );
  });
  test('rejects wrong version, target or unpinned archive, and missing license', () => {
    const value = setup();
    expect(() =>
      validateRipgrepCache(value.binary, value.license, {
        ...value.metadata,
        ripgrepVersion: 'wrong',
      })
    ).toThrow(/metadata/);
    expect(() =>
      validateRipgrepCache(value.binary, value.license, { ...value.metadata, target: 'wrong' })
    ).toThrow(/metadata/);
    expect(() =>
      validateRipgrepCache(value.binary, value.license, {
        ...value.metadata,
        archiveSha256: digest('an archive that was never pinned'),
      })
    ).toThrow(/metadata/);
    expect(() =>
      validateRipgrepCache(value.binary, path.join(value.root, 'missing'), value.metadata)
    ).toThrow(/license/);
  });
});
