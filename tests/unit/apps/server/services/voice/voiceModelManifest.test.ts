/**
 * voiceModelManifest — integrity of the pinned model set: every file has a real
 * sha256 + pinned revision, the voice catalog is well-formed, the default voice
 * exists, and the path resolvers point where the runtime expects.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The path resolvers resolve `~/.snaglet/...` through SNAGLET_HOME, but the shared-home
// fallbacks in modelReadPaths/archiveReadPaths read os.homedir() directly — so
// on a machine that already has a verified model copy under the real ~/.snaglet,
// voiceModelPaths() returns that path while espeakDataDir() returns the SNAGLET_HOME
// path, and the two disagree. Point homedir at an empty scratch dir so no
// fallback can find a real copy and every resolver stays about SNAGLET_HOME, on
// every machine. (os.homedir() ignores a late HOME change under jest, so the
// module is mocked — the same pattern as embedderModelManifest.test.)
const EMPTY_OS_HOME = mkdtempSync(path.join(tmpdir(), 'snaglet-voice-manifest-home-'));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: () => EMPTY_OS_HOME,
}));
afterAll(() => rmSync(EMPTY_OS_HOME, { recursive: true, force: true }));
import {
  DEFAULT_VOICE_ID,
  ESPEAK_ARCHIVE,
  espeakDataDir,
  findVoice,
  QUALITY_STT_MANIFEST,
  qualitySttModelPaths,
  resolveVoice,
  STT_MANIFEST,
  sttModelPaths,
  VAD_MANIFEST,
  vadModelPath,
  VOICE_CATALOG,
  VOICE_IDS,
  voiceModelPaths,
} from '@server/services/voice/voiceModelManifest';

const HEX64 = /^[0-9a-f]{64}$/;
const isSha1 = (s: string) => /^[0-9a-f]{40}$/.test(s);

describe('STT manifest', () => {
  it('pins encoder/decoder/joiner/tokens with real checksums', () => {
    const localPaths = STT_MANIFEST.files.map((f) => f.localPath);
    expect(localPaths).toEqual([
      'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      'tokens.txt',
    ]);
    for (const f of STT_MANIFEST.files) {
      expect(f.sha256).toMatch(HEX64);
      expect(f.bytes).toBeGreaterThan(0);
    }
    expect(isSha1(STT_MANIFEST.hf.revision)).toBe(true);
  });

  it('resolves the four STT roles to files under the model dir', () => {
    const p = sttModelPaths();
    expect(p.encoder).toContain(path.join('stt', STT_MANIFEST.modelId));
    expect(p.encoder.endsWith('.int8.onnx')).toBe(true);
    expect(p.tokens.endsWith('tokens.txt')).toBe(true);
  });
});

describe('Quality STT manifest (Moonshine base int8)', () => {
  it('pins the five Moonshine graphs with real checksums', () => {
    const localPaths = QUALITY_STT_MANIFEST.files.map((f) => f.localPath);
    expect(localPaths).toEqual([
      'preprocess.onnx',
      'encode.int8.onnx',
      'uncached_decode.int8.onnx',
      'cached_decode.int8.onnx',
      'tokens.txt',
    ]);
    for (const f of QUALITY_STT_MANIFEST.files) {
      expect(f.sha256).toMatch(HEX64);
      expect(f.bytes).toBeGreaterThan(0);
    }
    expect(isSha1(QUALITY_STT_MANIFEST.hf.revision)).toBe(true);
    expect(QUALITY_STT_MANIFEST.hf.repo).toBe('csukuangfj/sherpa-onnx-moonshine-base-en-int8');
  });

  it('resolves the five quality-STT roles to files under the model dir', () => {
    const p = qualitySttModelPaths();
    expect(p.preprocessor).toContain(path.join('stt', QUALITY_STT_MANIFEST.modelId));
    expect(p.encoder.endsWith('encode.int8.onnx')).toBe(true);
    expect(p.uncachedDecoder.endsWith('uncached_decode.int8.onnx')).toBe(true);
    expect(p.cachedDecoder.endsWith('cached_decode.int8.onnx')).toBe(true);
    expect(p.tokens.endsWith('tokens.txt')).toBe(true);
  });
});

describe('VAD manifest', () => {
  it('pins a single silero v5 onnx with a real checksum', () => {
    expect(VAD_MANIFEST.files).toHaveLength(1);
    expect(VAD_MANIFEST.files[0].sha256).toMatch(HEX64);
    expect(isSha1(VAD_MANIFEST.hf.revision)).toBe(true);
    expect(vadModelPath().endsWith('silero_vad.onnx')).toBe(true);
  });
});

describe('TTS voice catalog', () => {
  it('has four distinct voices, all with 3 pinned files', () => {
    expect(VOICE_CATALOG).toHaveLength(4);
    expect(new Set(VOICE_IDS).size).toBe(4);
    for (const v of VOICE_CATALOG) {
      expect(v.manifest.files).toHaveLength(3);
      for (const f of v.manifest.files) {
        expect(f.sha256).toMatch(HEX64);
        expect(f.bytes).toBeGreaterThan(0);
      }
      expect(isSha1(v.manifest.hf.revision)).toBe(true);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('each voice onnx sha256 is unique (distinct voices)', () => {
    const onnxShas = VOICE_CATALOG.map(
      (v) => v.manifest.files.find((f) => f.localPath === `${v.id}.onnx`)!.sha256
    );
    expect(new Set(onnxShas).size).toBe(4);
  });

  it('the default voice is Amy, installable from its pinned manifest', () => {
    expect(DEFAULT_VOICE_ID).toBe('en_US-amy-medium');
    const voice = findVoice(DEFAULT_VOICE_ID);
    expect(voice).toBeDefined();
    expect(isSha1(voice!.manifest.hf.revision)).toBe(true);
    expect(voice!.manifest.files.map((f) => f.localPath)).toEqual([
      `${DEFAULT_VOICE_ID}.onnx`,
      `${DEFAULT_VOICE_ID}.onnx.json`,
      'tokens.txt',
    ]);
    for (const f of voice!.manifest.files) {
      expect(f.sha256).toMatch(HEX64);
      expect(f.bytes).toBeGreaterThan(0);
    }
  });

  it('resolveVoice falls back to the default for unknown/empty ids', () => {
    expect(resolveVoice('does-not-exist').id).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoice(null).id).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoice('en_US-amy-medium').id).toBe('en_US-amy-medium');
  });

  it('voiceModelPaths point at the voice dir + shared espeak data', () => {
    const p = voiceModelPaths('en_US-ryan-medium');
    expect(p.model).toContain(path.join('tts', 'en_US-ryan-medium'));
    expect(p.model.endsWith('en_US-ryan-medium.onnx')).toBe(true);
    expect(p.dataDir).toBe(espeakDataDir());
    expect(p.dataDir.endsWith(path.join('tts', 'espeak-ng-data'))).toBe(true);
    // Unknown voice falls back to default.
    expect(voiceModelPaths('nope').model).toContain(DEFAULT_VOICE_ID);
  });
});

describe('espeak archive', () => {
  it('is pinned with a real sha256 and a sentinel', () => {
    expect(ESPEAK_ARCHIVE.sha256).toMatch(HEX64);
    expect(ESPEAK_ARCHIVE.bytes).toBeGreaterThan(0);
    expect(ESPEAK_ARCHIVE.member).toContain('espeak-ng-data');
    expect(ESPEAK_ARCHIVE.sentinelRelPath).toBe('phontab');
    expect(ESPEAK_ARCHIVE.destDir).toBe(espeakDataDir());
  });

  it("comes from the default voice's release archive, stripping its top folder", () => {
    expect(ESPEAK_ARCHIVE.url).toBe(
      `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${DEFAULT_VOICE_ID}.tar.bz2`
    );
    expect(ESPEAK_ARCHIVE.member).toBe(`vits-piper-${DEFAULT_VOICE_ID}/espeak-ng-data`);
    expect(ESPEAK_ARCHIVE.treeSha256).toMatch(HEX64);
  });
});
