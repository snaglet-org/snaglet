/**
 * clearSnagletVoiceStorageModel — the service behind removing a local model. Bad
 * input is a typed AppError (unknown id → 404) the route passes through; the
 * removal itself works against a throwaway home, never the real `~/.snaglet`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AppError } from '@snaglet/shared/utils';

const mockSetEnabled = jest.fn();

jest.mock('@server/services/localModels/localModelPreferences', () => ({
  getDisabledLocalModels: async () => new Set<string>(),
  setLocalModelEnabled: (id: string, enabled: boolean) => mockSetEnabled(id, enabled),
}));

import {
  clearSnagletVoiceStorageModel,
  getSnagletVoiceStorage,
} from '@server/services/snagletHome';

let home: string;

beforeEach(() => {
  jest.clearAllMocks();
  mockSetEnabled.mockResolvedValue(undefined);
  home = mkdtempSync(path.join(tmpdir(), 'snaglethome-models-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('clearSnagletVoiceStorageModel', () => {
  it('rejects an unknown model id with a 404 AppError and touches nothing', async () => {
    const err = await clearSnagletVoiceStorageModel('not-a-model', home).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, message: 'Unknown local model.' });
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("deletes a known model's files and marks it disabled", async () => {
    const model = (await getSnagletVoiceStorage(home)).find((entry) => entry.id === 'vad');
    if (!model) throw new Error('vad model entry missing');
    mkdirSync(model.path, { recursive: true });
    writeFileSync(path.join(model.path, 'model.onnx'), 'bytes');

    await clearSnagletVoiceStorageModel('vad', home);

    expect(existsSync(model.path)).toBe(false);
    expect(mockSetEnabled).toHaveBeenCalledWith('vad', false);
  });
});
