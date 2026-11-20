/**
 * Guard: one piper voice is excluded from Snaglet. No catalog entry, default,
 * shared-data source, installer plan or shipped source file (apps/, packages/,
 * docs/) names it, and the default voice is a different one, fully installable
 * from the manifest. The excluded name is built from parts so this guard does
 * not itself contain it.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const mockFetchModelFiles = jest.fn(async (..._args: unknown[]) => ({ files: [] }));
const mockFetchArchive = jest.fn(async (..._args: unknown[]) => ({ extracted: false, dir: '' }));
jest.mock('@server/services/localModels/fetchModelFiles', () => ({
  fetchModelFiles: (...args: unknown[]) => mockFetchModelFiles(...args),
}));
jest.mock('@server/services/voice/fetchArchive', () => ({
  fetchArchive: (...args: unknown[]) => mockFetchArchive(...args),
}));

import { DEFAULT_VOICE_ID as SESSION_DEFAULT_VOICE_ID } from '@server/services/SocketService/voiceSession/constants';
import { fetchVoiceModels } from '@server/services/voice/fetchVoiceModels';
import {
  DEFAULT_VOICE_ID,
  ESPEAK_ARCHIVE,
  findVoice,
  resolveVoice,
  VOICE_CATALOG,
} from '@server/services/voice/voiceModelManifest';

const REPO_ROOT = path.join(__dirname, '../../../..');
const RETIRED = new RegExp(['les', 'sac'].join(''), 'i');
const RETIRED_ID = ['en_US', ['les', 'sac'].join(''), 'medium'].join('-');
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs|scss|css|md|rs|swift|json|ya?ml|html|sh|toml|sql)$/;

describe('excluded piper voice', () => {
  it('is in no catalog entry, and the default is a different, installable voice', () => {
    for (const voice of VOICE_CATALOG) expect(JSON.stringify(voice)).not.toMatch(RETIRED);
    expect(DEFAULT_VOICE_ID).not.toMatch(RETIRED);
    expect(SESSION_DEFAULT_VOICE_ID).toBe(DEFAULT_VOICE_ID);
    expect(findVoice(DEFAULT_VOICE_ID)?.manifest.files.length).toBeGreaterThan(0);
  });

  it('is not the source of the shared phonemizer data', () => {
    expect(ESPEAK_ARCHIVE.url).not.toMatch(RETIRED);
    expect(ESPEAK_ARCHIVE.member).not.toMatch(RETIRED);
  });

  it('a stored id for it speaks in the default voice instead of breaking', () => {
    expect(findVoice(RETIRED_ID)).toBeUndefined();
    expect(resolveVoice(RETIRED_ID).id).toBe(DEFAULT_VOICE_ID);
  });

  it('is never planned by the voice installer, for the full catalog or the default', async () => {
    await fetchVoiceModels({ components: ['tts'] });
    await fetchVoiceModels({ components: ['tts'], voiceIds: [DEFAULT_VOICE_ID] });
    await fetchVoiceModels({ components: ['tts'], voiceIds: [RETIRED_ID] });

    expect(mockFetchModelFiles).toHaveBeenCalled();
    expect(JSON.stringify(mockFetchModelFiles.mock.calls)).not.toMatch(RETIRED);
    expect(JSON.stringify(mockFetchArchive.mock.calls)).not.toMatch(RETIRED);
  });

  it('is named by no shipped source file in apps/, packages/ or docs/', () => {
    const files = execFileSync('git', ['ls-files', '-z', 'apps', 'packages', 'docs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((file) => SCANNED.test(file));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) =>
      RETIRED.test(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
