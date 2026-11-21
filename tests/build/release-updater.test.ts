import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertUpdaterArchiveLayout,
  buildUpdaterManifest,
  readTarEntries,
  signedFileName,
  UPDATER_TAR_ENV,
  UPDATER_TARGET,
  updaterArchiveName,
  updaterSigningProblem,
  updaterTarCreateArgs,
  verifyUpdaterSignature,
} from '../../scripts/release/updater.mjs';

// Throwaway test fixture: a key pair made with `tauri signer generate` for this
// test only, its private key discarded. FIXTURE_SIGNATURE is the `.sig` that
// `tauri signer sign` wrote for FIXTURE_PAYLOAD. It protects nothing.
const FIXTURE_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYyMjU4MDAyRjA3NUNDNEQKUldSTnpIWHdBb0FsWXZxd3NXMnAxL3ZTM2xDaUwvOTdZMlhHK2RvTHNuSnVhYUNDcXhqRlFNTmYK';
const FIXTURE_SIGNATURE =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSTnpIWHdBb0FsWXV2aFZ2TXlQcnY3bHpNdGM5b21lSXA4MDRFc0lDRjl6dHdZOWxaRGJ6akZjWXc0NWxCcy9WWXNKaWd4TTFzMjRTRUFYdHM5eHhEZTkzRUQzY3Q0elE4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MjIwODIwCWZpbGU6cGF5bG9hZC50eHQKbmoxM3M0ZDZWVHBuUTUrTzJmSHJuZzlFYzdjcnArdTRuVkNNTG9yckVRMFM0b0t5bUhRSlhBZ3h6MVVPVVNUZ1QvRUgrQ3dzSzlCZVc0OGNDQ0NDQnc9PQo=';
const FIXTURE_PAYLOAD = 'Snaglet updater signature fixture\n';

const productionPubkey = (
  JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')) as {
    plugins: { updater: { pubkey: string } };
  }
).plugins.updater.pubkey;

function withTempDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snaglet-updater-test-'));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function reencodeSignature(edit: (lines: string[]) => void): string {
  const lines = Buffer.from(FIXTURE_SIGNATURE, 'base64').toString('utf8').split('\n');
  edit(lines);
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

test(
  'a signature from tauri signer verifies against its public key',
  withTempDir(async (dir) => {
    const file = path.join(dir, 'payload.txt');
    writeFileSync(file, FIXTURE_PAYLOAD);
    await verifyUpdaterSignature(file, FIXTURE_SIGNATURE, FIXTURE_PUBKEY);
    assert.equal(signedFileName(FIXTURE_SIGNATURE), 'payload.txt');
  })
);

test(
  'a changed archive, another key, or an edited trusted comment fails verification',
  withTempDir(async (dir) => {
    const file = path.join(dir, 'payload.txt');
    writeFileSync(file, FIXTURE_PAYLOAD.replace('fixture', 'fixturf'));
    await assert.rejects(
      verifyUpdaterSignature(file, FIXTURE_SIGNATURE, FIXTURE_PUBKEY),
      /does not match the archive/
    );

    writeFileSync(file, FIXTURE_PAYLOAD);
    await assert.rejects(
      verifyUpdaterSignature(file, FIXTURE_SIGNATURE, productionPubkey),
      /signed with key 62258002F075CC4D, but tauri\.conf\.json trusts key 485E18E68CB54523/
    );

    const edited = reencodeSignature((lines) => {
      lines[2] = lines[2].replace('payload.txt', 'payload.tar');
    });
    await assert.rejects(
      verifyUpdaterSignature(file, edited, FIXTURE_PUBKEY),
      /invalid trusted comment/
    );

    const legacy = reencodeSignature((lines) => {
      const raw = Buffer.from(lines[1], 'base64');
      raw[1] = 0x64; // `Ed`: the unhashed legacy form
      lines[1] = raw.toString('base64');
    });
    await assert.rejects(verifyUpdaterSignature(file, legacy, FIXTURE_PUBKEY), /prehashed/);
    await assert.rejects(verifyUpdaterSignature(file, 'not a signature', FIXTURE_PUBKEY));
  })
);

test(
  'base64 is decoded as strictly as the plugin decodes it',
  withTempDir(async (dir) => {
    const file = path.join(dir, 'payload.txt');
    writeFileSync(file, FIXTURE_PAYLOAD);
    // Node would quietly accept each of these; the plugin's STANDARD engine refuses them.
    const unpadded = FIXTURE_SIGNATURE.replace(/=+$/, '');
    const wrapped = `${FIXTURE_SIGNATURE.slice(0, 60)}\n${FIXTURE_SIGNATURE.slice(60)}`;
    const stray = `${FIXTURE_SIGNATURE.slice(0, 60)}*${FIXTURE_SIGNATURE.slice(60)}`;
    for (const signature of [unpadded, wrapped, stray, ` ${FIXTURE_SIGNATURE}`]) {
      await assert.rejects(
        verifyUpdaterSignature(file, signature, FIXTURE_PUBKEY),
        /not valid base64/
      );
    }
    await assert.rejects(
      verifyUpdaterSignature(file, FIXTURE_SIGNATURE, `${FIXTURE_PUBKEY}\n`),
      /not valid base64/
    );
  })
);

test('latest.json follows the plugin static format and points at the release asset', () => {
  const archiveName = updaterArchiveName('v1.2.3');
  assert.equal(archiveName, 'Snaglet-v1.2.3-macos-arm64.app.tar.gz');
  const manifest = buildUpdaterManifest({
    tag: 'v1.2.3',
    repository: 'owner/repo',
    archiveName,
    signature: 'c2ln',
    notes: 'Snaglet v1.2.3',
    pubDate: new Date('2026-11-20T10:11:12.345Z'),
  });
  assert.deepEqual(manifest, {
    version: '1.2.3',
    notes: 'Snaglet v1.2.3',
    pub_date: '2026-11-20T10:11:12Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'c2ln',
        url: 'https://github.com/owner/repo/releases/download/v1.2.3/Snaglet-v1.2.3-macos-arm64.app.tar.gz',
      },
    },
  });
  assert.equal(UPDATER_TARGET, 'darwin-aarch64');
  const base = { repository: 'owner/repo', archiveName, notes: '', pubDate: new Date() };
  assert.throws(() => buildUpdaterManifest({ ...base, tag: '1.2.3', signature: 's' }), /tag/);
  assert.throws(() => buildUpdaterManifest({ ...base, tag: 'v1.2.3', signature: '' }), /signature/);
});

test('signing refuses to start without a key and password in the environment', () => {
  assert.match(updaterSigningProblem({}) ?? '', /No updater signing key/);
  assert.match(
    updaterSigningProblem({ TAURI_SIGNING_PRIVATE_KEY_PATH: '/keys/snaglet.key' }) ?? '',
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set/
  );
  assert.equal(
    updaterSigningProblem({
      TAURI_SIGNING_PRIVATE_KEY_PATH: '/keys/snaglet.key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    }),
    null
  );
  assert.equal(
    updaterSigningProblem({
      TAURI_SIGNING_PRIVATE_KEY: 'inline',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw',
    }),
    null
  );
});

test('archive layout check accepts one app root and refuses what the plugin cannot unpack', () => {
  type Entry = { name: string; type: string; mode: number; linkname: string; paxKeys: string[] };
  const entry = (name: string, type: string, mode = 0o755, paxKeys: string[] = []): Entry => ({
    name,
    type,
    mode,
    linkname: '',
    paxKeys,
  });
  const entries = [
    entry('Snaglet.app/', '5'),
    entry('Snaglet.app/Contents/', '5'),
    entry('Snaglet.app/Contents/Info.plist', '0', 0o644),
    entry('Snaglet.app/Contents/_CodeSignature/', '5'),
    entry('Snaglet.app/Contents/_CodeSignature/CodeResources', '0', 0o644),
    entry('Snaglet.app/Contents/Resources/lib', '2'),
  ];
  assert.doesNotThrow(() => assertUpdaterArchiveLayout({ entries }));

  const swap = (index: number, replacement: Entry, globalKeys: string[] = []) => {
    const next = [...entries];
    next[index] = replacement;
    return () => assertUpdaterArchiveLayout({ entries: next, globalKeys });
  };
  assert.throws(swap(0, entry('./', '5')), /must start with Snaglet\.app\//);
  assert.throws(swap(5, entry('Other.app/lib', '0')), /outside Snaglet\.app/);
  assert.throws(swap(5, entry('/Snaglet.app/lib', '0')), /outside Snaglet\.app/);
  assert.throws(swap(5, entry('Snaglet.app/Contents/._Info.plist', '0')), /AppleDouble/);
  assert.throws(swap(5, entry('Snaglet.app/../evil', '0')), /parent-relative/);
  assert.throws(swap(5, entry('Snaglet.app/Contents/lib', '1')), /hard link/);
  assert.throws(swap(5, entry('Snaglet.app/Contents/fifo', '6')), /entry of type 6/);
  assert.throws(swap(5, entry('Snaglet.app/Contents/sp', 'S')), /sparse/);
  assert.throws(swap(5, entry('Snaglet.app/Contents/GNUSparseFile.0/sp', '0')), /sparse/);
  assert.throws(
    swap(5, entry('Snaglet.app/Contents/sp', '0', 0o644, ['GNU.sparse.major'])),
    /sparse/
  );
  assert.throws(swap(5, entry('Snaglet.app/Contents/x', '0'), ['GNU.sparse.name']), /sparse/);
  assert.throws(
    swap(5, entry('Snaglet.app/Contents/x', '0', 0o644, ['SCHILY.xattr.com.apple.quarantine'])),
    /extended attributes/
  );
  assert.throws(swap(1, entry('Snaglet.app/Contents/', '5', 0o555)), /not owner-writable/);
  assert.throws(swap(4, entry('Snaglet.app/Contents/Resources/x', '0')), /missing .*CodeResources/);
  assert.throws(() => assertUpdaterArchiveLayout({ entries: [] }), /empty/);
});

/** A small bundle with a symlink, an xattr and a genuinely sparse file. */
function makeBundle(dir: string): string {
  const app = path.join(dir, 'Snaglet.app');
  mkdirSync(path.join(app, 'Contents/_CodeSignature'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/Info.plist'), '<plist/>');
  writeFileSync(path.join(app, 'Contents/_CodeSignature/CodeResources'), '<plist/>');
  writeFileSync(path.join(app, 'Contents/Resources/data.txt'), 'data');
  symlinkSync('data.txt', path.join(app, 'Contents/Resources/link'));
  // An extended attribute is exactly what turns into a `._` entry by default.
  execFileSync('xattr', ['-w', 'com.example.test', 'x', path.join(app, 'Contents/Info.plist')]);
  // Writing past a hole leaves a sparse file, which bsdtar archives as a pax
  // sparse entry unless told not to read sparseness.
  const fd = openSync(path.join(app, 'Contents/Resources/sparse.bin'), 'w');
  writeSync(fd, Buffer.from('end'), 0, 3, 16 * 1024 * 1024);
  closeSync(fd);
  return app;
}

test(
  'the shared archive flags yield the layout the plugin expects, sparse files included',
  { skip: process.platform !== 'darwin' },
  withTempDir(async (dir) => {
    makeBundle(dir);
    const archive = path.join(dir, 'out.app.tar.gz');
    execFileSync('tar', updaterTarCreateArgs(archive, dir), {
      env: { ...process.env, ...UPDATER_TAR_ENV },
    });
    const listing = await readTarEntries(archive);
    assert.doesNotThrow(() => assertUpdaterArchiveLayout(listing));
    const byName = new Map(listing.entries.map((e) => [e.name, e]));
    assert.equal(byName.get('Snaglet.app/Contents/Resources/link')?.type, '2');
    assert.equal(byName.get('Snaglet.app/Contents/Resources/link')?.linkname, 'data.txt');
    assert.equal(byName.get('Snaglet.app/Contents/Resources/sparse.bin')?.type, '0');

    // Without --no-read-sparse the same bundle carries a sparse entry under a
    // GNUSparseFile name, which the plugin's tar crate would unpack there.
    const sparse = path.join(dir, 'sparse.app.tar.gz');
    const flags = updaterTarCreateArgs(sparse, dir).filter((arg) => arg !== '--no-read-sparse');
    execFileSync('tar', flags, { env: { ...process.env, ...UPDATER_TAR_ENV } });
    const sparseListing = await readTarEntries(sparse);
    assert.ok(sparseListing.entries.some((e) => e.name.includes('/GNUSparseFile.')));
    assert.throws(() => assertUpdaterArchiveLayout(sparseListing), /sparse entry/);
  })
);

test(
  'a hard link in the bundle is refused',
  { skip: process.platform !== 'darwin' },
  withTempDir(async (dir) => {
    const app = makeBundle(dir);
    linkSync(path.join(app, 'Contents/Resources/data.txt'), path.join(app, 'Contents/hard.txt'));
    const archive = path.join(dir, 'out.app.tar.gz');
    execFileSync('tar', updaterTarCreateArgs(archive, dir), {
      env: { ...process.env, ...UPDATER_TAR_ENV },
    });
    const listing = await readTarEntries(archive);
    assert.throws(() => assertUpdaterArchiveLayout(listing), /hard link/);
  })
);
