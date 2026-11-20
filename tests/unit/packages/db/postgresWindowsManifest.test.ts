import { describe, expect, it } from '@jest/globals';
import {
  applyWindowsUtf8Manifests,
  hasEmbeddedApplicationManifest,
} from '@snaglet/db/runtime/postgres/windows-manifest';

function executable(options: { resources?: boolean; manifest?: boolean } = {}): Buffer {
  const image = Buffer.alloc(1024);
  image.write('MZ');
  image.writeUInt32LE(64, 0x3c);
  image.writeUInt32LE(0x4550, 64);
  image.writeUInt16LE(1, 70); // section count
  image.writeUInt16LE(240, 84); // optional header size
  image.writeUInt16LE(0x20b, 88); // PE32+
  if (options.resources) {
    image.writeUInt32LE(0x1000, 88 + 112 + 16);
    image.writeUInt32LE(0x1000, 328 + 12);
    image.writeUInt32LE(512, 328 + 16);
    image.writeUInt32LE(512, 328 + 20);
    image.writeUInt16LE(1, 512 + 14);
    image.writeUInt32LE(options.manifest ? 24 : 16, 528); // RT_MANIFEST or RT_VERSION
    image.writeUInt32LE(0x80000020, 532);
    image.writeUInt16LE(1, 544 + 14);
    image.writeUInt32LE(1, 560);
    image.writeUInt32LE(0x80000040, 564);
  }
  return image;
}

describe('Windows UTF-8 executable manifests', () => {
  it('distinguishes absent resources and version-only resources from manifest #1', () => {
    expect(hasEmbeddedApplicationManifest(executable())).toBe(false);
    expect(hasEmbeddedApplicationManifest(executable({ resources: true }))).toBe(false);
    expect(hasEmbeddedApplicationManifest(executable({ resources: true, manifest: true }))).toBe(
      true
    );
  });

  it('fails closed on malformed executable input', () => {
    expect(() => hasEmbeddedApplicationManifest(Buffer.from('not PE'))).toThrow();
    const image = executable({ resources: true });
    image.writeUInt32LE(0x70000000, 328 + 20);
    expect(() => hasEmbeddedApplicationManifest(image)).toThrow();
  });

  it('reports a missing SDK environment before touching any executable', async () => {
    await expect(
      applyWindowsUtf8Manifests('unused', ['postgres.exe'], 'unused', {})
    ).rejects.toThrow(/Windows SDK environment is missing/);
  });
});
