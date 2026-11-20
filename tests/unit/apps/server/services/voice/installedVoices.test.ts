/**
 * installedVoices — which voices are installed comes from disk on every call:
 * a voice counts once its model and tokens files are present and it was not
 * uninstalled (marked disabled).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Shared-home read paths look in os.homedir(); point it at an empty scratch dir
// so no real model copy on this machine is ever read (see voiceModelManifest.test).
const EMPTY_OS_HOME = mkdtempSync(path.join(tmpdir(), 'snaglet-installed-voices-home-'));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: () => EMPTY_OS_HOME,
}));
afterAll(() => rmSync(EMPTY_OS_HOME, { recursive: true, force: true }));

const mockPresent = new Set<string>();
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  access: jest.fn(async (file: string) => {
    if (!mockPresent.has(file)) throw new Error('ENOENT');
  }),
}));
const mockDisabled = new Set<string>();
jest.mock('@server/services/localModels/localModelPreferences', () => ({
  getDisabledLocalModels: async () => mockDisabled,
}));

import {
  installedVoiceIds,
  voiceLang,
  voiceModelId,
  voiceQuality,
} from '@server/services/voice/installedVoices';
import { voiceModelPaths } from '@server/services/voice/voiceModelManifest';

function install(voiceId: string, files: Array<'model' | 'tokens'> = ['model', 'tokens']) {
  const paths = voiceModelPaths(voiceId);
  for (const file of files) mockPresent.add(paths[file]);
}

beforeEach(() => {
  mockPresent.clear();
  mockDisabled.clear();
});

describe('installedVoiceIds', () => {
  it('lists the voices whose files are on disk, in catalog order', async () => {
    install('en_US-joe-medium');
    install('en_US-ryan-medium');
    expect(await installedVoiceIds()).toEqual(['en_US-ryan-medium', 'en_US-joe-medium']);
  });

  it('skips a voice missing a file, and a voice that was uninstalled', async () => {
    install('en_US-amy-medium', ['model']);
    install('en_US-ryan-medium');
    mockDisabled.add(voiceModelId('en_US-ryan-medium'));
    expect(await installedVoiceIds()).toEqual([]);
  });
});

describe('voice id parts', () => {
  it('reads the language and quality from a piper voice id', () => {
    expect(voiceLang('en_GB-alan-medium')).toBe('en-GB');
    expect(voiceQuality('en_GB-alan-medium')).toBe('medium');
    expect(voiceModelId('en_GB-alan-medium')).toBe('tts:en_GB-alan-medium');
  });
});
