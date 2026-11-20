import { localModels } from '@server/services/settings/categories/localModels';
import { settingsService } from '@server/services/settings';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';

let preferenceWrite: Promise<void> = Promise.resolve();

export async function getDisabledLocalModels(): Promise<Set<string>> {
  const preferences = await settingsService.read(localModels.preferences);
  return new Set(preferences.disabled);
}

export async function isLocalModelEnabled(modelId: string): Promise<boolean> {
  return !(await getDisabledLocalModels()).has(modelId);
}

/** Serialize read-modify-write updates so concurrent UI actions cannot lose IDs. */
export async function setLocalModelEnabled(modelId: string, enabled: boolean): Promise<void> {
  const next = preferenceWrite.then(async () => {
    const disabled = await getDisabledLocalModels();
    if (enabled) disabled.delete(modelId);
    else disabled.add(modelId);
    await settingsService.write(localModels.preferences, { disabled: [...disabled].sort() });
  });
  preferenceWrite = next.catch((err: unknown) => {
    // The failure already propagates to the caller via `await next`; this
    // reset only keeps the write queue usable for later updates.
    logger.warn(`[local-models] preference write failed: ${getErrorMessage(err)}`);
  });
  await next;
}
