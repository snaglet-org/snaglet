/**
 * Release artifacts for in-place updates: the archive tauri-plugin-updater
 * installs, the checks it must pass, and the static latest.json the app reads.
 *
 * On macOS the plugin (tauri-plugin-updater 2.x, src/updater.rs, `install_inner`)
 * gunzips and untars the archive with the `tar` crate, drops the first path
 * component of every entry, and unpacks each entry on its own into a temp
 * directory that then replaces the running Snaglet.app. That unpacking skips
 * extended attributes, cannot link a hard-link entry, does not understand
 * sparse entries, and applies a directory's mode before its children are
 * written.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

/** The `platforms` key the plugin looks up on an Apple Silicon Mac (`{os}-{arch}`). */
export const UPDATER_TARGET = 'darwin-aarch64';

const TAG = /^v\d+\.\d+\.\d+(-[\w.]+)?$/;

export function updaterArchiveName(tag) {
  return `Snaglet-${tag}-macos-arm64.app.tar.gz`;
}

/**
 * The bsdtar arguments that archive `parentDir/appName` the way the plugin can
 * unpack it: no AppleDouble `._` files, no extended attributes, ACLs or file
 * flags, and no sparse entries. Run with UPDATER_TAR_ENV.
 */
export function updaterTarCreateArgs(archivePath, parentDir, appName = 'Snaglet.app') {
  return [
    '-c',
    '-z',
    '--no-mac-metadata',
    '--no-xattrs',
    '--no-acls',
    '--no-fflags',
    '--no-read-sparse',
    '-f',
    archivePath,
    '-C',
    parentDir,
    appName,
  ];
}

export const UPDATER_TAR_ENV = { COPYFILE_DISABLE: '1' };

/**
 * Why `tauri signer sign` cannot run unattended with this environment, or
 * null. The key only ever reaches the signer through the environment.
 */
export function updaterSigningProblem(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return 'No updater signing key: set TAURI_SIGNING_PRIVATE_KEY_PATH (or TAURI_SIGNING_PRIVATE_KEY).';
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    return 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set (use an empty value for a key without a password).';
  }
  return null;
}

/** The static update manifest tauri-plugin-updater reads from the release. */
export function buildUpdaterManifest({ tag, repository, archiveName, signature, notes, pubDate }) {
  if (!TAG.test(tag)) throw new Error(`Not a release tag: ${tag}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`Not owner/repo: ${repository}`);
  if (!signature) throw new Error('The updater manifest needs the archive signature.');
  return {
    version: tag.slice(1),
    notes,
    // RFC 3339 without milliseconds, as the plugin's `time` parser expects.
    pub_date: pubDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      [UPDATER_TARGET]: {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(archiveName)}`,
      },
    },
  };
}

// tar headers, read the way the `tar` crate reads them

/** NUL-terminated header field. */
function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.toString('utf8', 0, end === -1 ? length : end);
}

function octal(header, start, length) {
  if (header[start] & 0x80) throw new Error('An update archive entry is too large to read.');
  return parseInt(field(header, start, length).trim() || '0', 8);
}

/** `"<length> <key>=<value>\n"` records of a pax extended header. */
function paxRecords(body) {
  const records = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = Number(body.toString('latin1', at, space));
    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      throw new Error('The update archive has a malformed pax header.');
    }
    const record = body.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    records.push([record.slice(0, equals), record.slice(equals + 1)]);
    at += length;
  }
  return records;
}

/**
 * Every entry header in a gzip tar, with pax `path`/`linkpath` and GNU long
 * names applied, as the `tar` crate applies them. `type` is the raw type flag
 * (`0` file, `1` hard link, `2` symlink, `5` directory, `S` GNU sparse) and
 * `paxKeys` the extended keys the entry carried. bsdtar's own listing hides
 * sparse entries behind their real names; this does not.
 */
export async function readTarEntries(file) {
  const entries = [];
  const globalKeys = [];
  let local = { keys: [], path: null, linkpath: null };
  let longName = null;
  let longLink = null;
  let extension = null;
  let skip = 0;
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    while (at < data.length) {
      if (skip > 0) {
        const step = Math.min(skip, data.length - at);
        skip -= step;
        at += step;
        continue;
      }
      if (extension) {
        if (data.length - at < extension.padded) break;
        const body = data.subarray(at, at + extension.size);
        at += extension.padded;
        if (extension.type === 'L') longName = field(body, 0, body.length);
        else if (extension.type === 'K') longLink = field(body, 0, body.length);
        else {
          for (const [key, value] of paxRecords(body)) {
            if (extension.type === 'g') globalKeys.push(key);
            else {
              local.keys.push(key);
              if (key === 'path') local.path = value;
              if (key === 'linkpath') local.linkpath = value;
            }
          }
        }
        extension = null;
        continue;
      }
      if (data.length - at < 512) break;
      const header = data.subarray(at, at + 512);
      at += 512;
      if (header.every((byte) => byte === 0)) continue;
      const type = String.fromCharCode(header[156] || 0x30);
      const size = octal(header, 124, 12);
      const padded = Math.ceil(size / 512) * 512;
      if ('xgLK'.includes(type)) {
        if (padded > 1 << 24) throw new Error('The update archive has an oversized header.');
        extension = { type, size, padded };
        continue;
      }
      const posix = header.toString('latin1', 257, 263) === 'ustar\0';
      const prefix = posix ? field(header, 345, 155) : '';
      const name = field(header, 0, 100);
      entries.push({
        name: local.path ?? longName ?? (prefix ? `${prefix}/${name}` : name),
        type,
        mode: octal(header, 100, 8),
        linkname: local.linkpath ?? longLink ?? field(header, 157, 100),
        paxKeys: local.keys,
      });
      local = { keys: [], path: null, linkpath: null };
      longName = null;
      longLink = null;
      skip = padded;
    }
    pending = Buffer.from(data.subarray(at));
  }
  return { entries, globalKeys };
}

const SPARSE_KEY = /^GNU\.sparse\./;

/**
 * Refuse an archive the plugin would unpack into something other than the
 * signed app. Takes `readTarEntries` output.
 */
export function assertUpdaterArchiveLayout({ entries, globalKeys = [] }, appName = 'Snaglet.app') {
  if (entries.length === 0) throw new Error('The update archive is empty.');
  if (entries[0].name.replace(/\/$/, '') !== appName || entries[0].type !== '5') {
    throw new Error(`The update archive must start with ${appName}/, found ${entries[0].name}`);
  }
  if (globalKeys.some((key) => SPARSE_KEY.test(key))) {
    throw new Error('The update archive holds sparse entries, which the updater cannot unpack.');
  }
  const names = new Set();
  for (const { name, type, mode, paxKeys } of entries) {
    const parts = name.split('/').filter(Boolean);
    if (name.startsWith('/') || parts[0] !== appName) {
      throw new Error(`Entry outside ${appName}/: ${name}`);
    }
    if (parts.some((part) => part === '..' || part.startsWith('._'))) {
      throw new Error(`The update archive holds an AppleDouble or parent-relative entry: ${name}`);
    }
    if (
      type === 'S' ||
      paxKeys.some((key) => SPARSE_KEY.test(key)) ||
      parts.some((part) => part.startsWith('GNUSparseFile'))
    ) {
      throw new Error(`The update archive holds a sparse entry the updater cannot unpack: ${name}`);
    }
    if (paxKeys.some((key) => /^(?:SCHILY|LIBARCHIVE)\.xattr\./.test(key))) {
      throw new Error(`The update archive carries extended attributes: ${name}`);
    }
    if (type === '1') throw new Error(`The update archive holds a hard link: ${name}`);
    if (!['0', '2', '5'].includes(type)) {
      throw new Error(`The update archive holds an entry of type ${type}: ${name}`);
    }
    if (type === '5' && (mode & 0o200) === 0) {
      throw new Error(
        `Directory is not owner-writable, so its contents cannot be unpacked: ${name}`
      );
    }
    names.add(parts.join('/'));
  }
  for (const required of ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources']) {
    if (!names.has(`${appName}/${required}`)) {
      throw new Error(`The update archive is missing ${appName}/${required}`);
    }
  }
}

// minisign, decoded and checked as the plugin does (base64 STANDARD engine
// for the outer value, minisign-verify for the rest)

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Canonical padded base64 only: no whitespace, no stray bits. */
function strictBase64(text, what) {
  const value = String(text);
  const bytes = BASE64.test(value) ? Buffer.from(value, 'base64') : null;
  if (!bytes || bytes.toString('base64') !== value) {
    throw new Error(`${what} is not valid base64.`);
  }
  return bytes;
}

function minisignLines(value, what) {
  const lines = strictBase64(value, what).toString('utf8').split(/\r?\n/);
  if (lines.length < 2) throw new Error(`${what} is not a minisign file.`);
  return lines;
}

function decodePublicKey(pubkey) {
  const what = 'The updater public key';
  const raw = strictBase64(minisignLines(pubkey, what)[1], what);
  if (raw.length !== 42 || raw[0] !== 0x45 || ![0x64, 0x44].includes(raw[1])) {
    throw new Error('The updater public key is not a minisign Ed25519 key.');
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

function decodeSignature(signature) {
  const what = 'The updater signature';
  const lines = minisignLines(signature, what);
  const raw = strictBase64(lines[1] ?? '', what);
  const global = strictBase64(lines[3] ?? '', what);
  const trusted = lines[2] ?? '';
  if (raw.length !== 74 || global.length !== 64 || !trusted.startsWith('trusted comment: ')) {
    throw new Error('The updater signature is not a minisign signature.');
  }
  // `ED` is the prehashed form `tauri signer sign` writes; the plugin also
  // accepts legacy `Ed`, but our signer never produces it.
  if (raw.subarray(0, 2).toString('latin1') !== 'ED') {
    throw new Error('The updater signature is not a prehashed (ED) minisign signature.');
  }
  return {
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice('trusted comment: '.length),
    globalSignature: global,
  };
}

/**
 * The file name `tauri signer sign` recorded in the signature's trusted
 * comment (`timestamp:…\tfile:<name>`). The app refuses an archive whose
 * signed name is not the one for the version it is offered.
 */
export function signedFileName(signature) {
  const { trustedComment } = decodeSignature(signature);
  const file = trustedComment.split('\t').find((part) => part.startsWith('file:'));
  return file ? file.slice('file:'.length) : null;
}

async function blake2b512(file) {
  const hash = createHash('blake2b512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest();
}

/**
 * Verify `signature` (the base64 `.sig` content) over `file` with `pubkey`
 * (the base64 `pubkey` from tauri.conf.json), the way the installed app will.
 * Needs no private key. Throws with the reason when it does not verify.
 */
export async function verifyUpdaterSignature(file, signature, pubkey) {
  const publicKey = decodePublicKey(pubkey);
  const decoded = decodeSignature(signature);
  if (!decoded.keyId.equals(publicKey.keyId)) {
    throw new Error(
      `The archive was signed with key ${hexKeyId(decoded.keyId)}, but tauri.conf.json trusts ` +
        `key ${hexKeyId(publicKey.keyId)}. Installed apps would reject this update.`
    );
  }
  if (!verify(null, await blake2b512(file), publicKey.key, decoded.signature)) {
    throw new Error('The updater signature does not match the archive.');
  }
  const global = Buffer.concat([decoded.signature, Buffer.from(decoded.trustedComment, 'utf8')]);
  if (!verify(null, global, publicKey.key, decoded.globalSignature)) {
    throw new Error('The updater signature has an invalid trusted comment.');
  }
}

/** minisign prints key ids as little-endian hex. */
function hexKeyId(keyId) {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}
