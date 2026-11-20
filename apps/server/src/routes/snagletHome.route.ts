/**
 * snagletHome routes — manage the Snaglet home-path override from Settings → Profile.
 * Mounted at `/api/snaglet-home` in both dev and prod (the packaged app must be able
 * to change its data dir).
 *
 * GET    /api/snaglet-home           → { active, override, saved }
 * POST   /api/snaglet-home/override  → { path } — set override (+ add to saved)
 * DELETE /api/snaglet-home/override  — clear override
 * POST   /api/snaglet-home/saved     → { path } — register a path without activating
 * DELETE /api/snaglet-home/saved     → { path } — remove from registry
 *
 * All state lives in the single pointer file `~/.snaglet.json` (see snagletHome.ts).
 * Changes take effect after a restart (SNAGLET_HOME is resolved once at startup).
 */

import { Router } from 'express';
import { writeFile } from 'fs/promises';

import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import {
  SNAGLET_HOME,
  SNAGLET_POINTER_FILE,
  canonicalizeHomePath,
  readSnagletPointer,
  validateHomePath,
  type SnagletPointer,
  getSnagletStorage,
  clearSnagletStorageCategory,
  getSnagletVoiceStorage,
  clearSnagletVoiceStorageModel,
  getSnagletVoiceStorageModel,
  type SnagletVoiceStorageModel,
} from '@server/services/snagletHome';
import { getHookRegistry } from '@server/services/customHooks/HookRegistryService';
import { fetchRerankerModel } from '@server/services/reranking/fetchRerankerModel';
import { releaseLocalReranker } from '@server/services/reranking/LocalRerankerService';
import { isRerankerEnabled, RERANKER_OFF_MESSAGE } from '@server/services/reranking/rerankerFlag';
import { fetchVoiceModels } from '@server/services/voice/fetchVoiceModels';
import { setLocalModelEnabled } from '@server/services/localModels/localModelPreferences';

export const snagletHomeRouter = Router();

/**
 * Local models as Settings → Storage shows them. With the `reranker` flag off
 * the reranker is listed only while its files are on disk, so it can still be
 * removed but is never offered as a download.
 */
async function reportedLocalModels(): Promise<SnagletVoiceStorageModel[]> {
  const models = await getSnagletVoiceStorage();
  if (await isRerankerEnabled()) return models;
  return models.filter((model) => model.id !== 'reranker' || (model.installed && !model.disabled));
}

snagletHomeRouter.get('/storage', async (_req, res) => {
  try {
    const categories = await getSnagletStorage();
    const localModels = await reportedLocalModels();
    res.json({
      categories,
      localModels,
      totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

snagletHomeRouter.delete('/storage/local-models/:id', async (req, res) => {
  try {
    await clearSnagletVoiceStorageModel(req.params.id);
    if (req.params.id === 'reranker') await releaseLocalReranker();
    const categories = await getSnagletStorage();
    const localModels = await reportedLocalModels();
    res.json({
      categories,
      localModels,
      totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    });
  } catch (err) {
    // Bad input (unknown id, a model that can't be removed) carries its own
    // 404/400; a failed delete or storage read is ours, so 500.
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: getErrorMessage(err) });
  }
});

snagletHomeRouter.post('/storage/local-models/:id/enable', async (req, res) => {
  const id = req.params.id;
  try {
    if (id === 'reranker' && !(await isRerankerEnabled())) {
      res.status(409).json({ error: RERANKER_OFF_MESSAGE });
      return;
    }
    await getSnagletVoiceStorageModel(id);
    if (id === 'reranker') await fetchRerankerModel();
    else if (id === 'stt-streaming' || id === 'stt-quality') {
      await fetchVoiceModels({ components: ['stt'] });
    } else if (id === 'vad') await fetchVoiceModels({ components: ['vad'] });
    else if (id === 'tts-espeak') await fetchVoiceModels({ components: ['tts'], voiceIds: [] });
    else if (id.startsWith('tts:')) {
      await fetchVoiceModels({ components: ['tts'], voiceIds: [id.slice(4)] });
    } else {
      res.status(400).json({ error: 'Unknown local model.' });
      return;
    }
    await setLocalModelEnabled(id, true);
    if (id.startsWith('tts:')) await setLocalModelEnabled('tts-espeak', true);
    const categories = await getSnagletStorage();
    const localModels = await reportedLocalModels();
    res.json({
      categories,
      localModels,
      totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(message === 'Unknown local model.' ? 400 : 500).json({ error: message });
  }
});

snagletHomeRouter.delete('/storage/:key', async (req, res) => {
  const key = req.params.key;
  if (!['models', 'logs', 'build', 'temp'].includes(key)) {
    res.status(400).json({ error: 'Only reconstructable storage can be cleared.' });
    return;
  }
  try {
    await clearSnagletStorageCategory(key as 'models' | 'logs' | 'build' | 'temp');
    const categories = await getSnagletStorage();
    const localModels = await getSnagletVoiceStorage();
    if (key === 'models') {
      await Promise.all(localModels.map((model) => setLocalModelEnabled(model.id, false)));
    }
    // Hook bundles live in build/; rebuild them from source in the background
    // (measured above, so the report still shows the cleared size).
    if (key === 'build') void getHookRegistry().rebuildRegisteredHooks();
    res.json({
      categories,
      localModels: await reportedLocalModels(),
      totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

async function writePointer(pointer: SnagletPointer): Promise<void> {
  await writeFile(SNAGLET_POINTER_FILE, JSON.stringify(pointer, null, 2), 'utf-8');
}

/** Max remembered home paths; older entries fall off the end. */
const MAX_RECENT_PATHS = 10;

function addToSaved(saved: string[], newPath: string): string[] {
  const deduped = saved.filter((p) => p !== newPath);
  return [newPath, ...deduped].slice(0, MAX_RECENT_PATHS);
}

function isStandaloneEnvPinned(): boolean {
  return Boolean(process.env.SNAGLET_HOME?.trim()) && !process.env.SNAGLET_PARENT_PID;
}

function buildState(
  saved: string[],
  override: string | null
): {
  active: string;
  override: string | null;
  saved: string[];
} {
  if (!isStandaloneEnvPinned()) {
    return { active: SNAGLET_HOME, override, saved };
  }

  return {
    active: SNAGLET_HOME,
    override: SNAGLET_HOME,
    saved: addToSaved(saved, SNAGLET_HOME),
  };
}

/** GET /api/snaglet-home */
snagletHomeRouter.get('/', (_req, res) => {
  try {
    const { homePath = null, recentPaths = [] } = readSnagletPointer();
    res.json(buildState(recentPaths, homePath));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

/** POST /api/snaglet-home/override — set the active override */
snagletHomeRouter.post('/override', async (req, res) => {
  const { path: newPath } = (req.body ?? {}) as { path?: string };
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const trimmed = newPath.trim();
  try {
    // "Valid" = writable, not merely present. Reject (don't save) a bad path so
    // a typo or read-only location surfaces an error instead of locking the user
    // into an unusable home on the next restart.
    const validation = await validateHomePath(trimmed);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason });
      return;
    }
    // Persist the canonical path validation resolved, not the raw input, so
    // dedupe and pointer/DB-lock equality compare consistent strings.
    const canonical = validation.path;
    const pointer = readSnagletPointer();
    const next: SnagletPointer = {
      homePath: canonical,
      recentPaths: addToSaved(pointer.recentPaths ?? [], canonical),
    };
    await writePointer(next);
    res.json(buildState(next.recentPaths ?? [], canonical));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

/** DELETE /api/snaglet-home/override — clear the override (revert to default) */
snagletHomeRouter.delete('/override', async (_req, res) => {
  try {
    const pointer = readSnagletPointer();
    const next: SnagletPointer = { recentPaths: pointer.recentPaths ?? [] };
    await writePointer(next);
    res.json(buildState(next.recentPaths ?? [], null));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

/** POST /api/snaglet-home/saved — register a path without activating it */
snagletHomeRouter.post('/saved', async (req, res) => {
  const { path: newPath } = (req.body ?? {}) as { path?: string };
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const trimmed = newPath.trim();
  try {
    // Canonicalize so the saved entry matches what an override would persist,
    // keeping dedupe and removal consistent regardless of casing/symlinks.
    const canonical = await canonicalizeHomePath(trimmed);
    const pointer = readSnagletPointer();
    const next: SnagletPointer = {
      homePath: pointer.homePath,
      recentPaths: addToSaved(pointer.recentPaths ?? [], canonical),
    };
    await writePointer(next);
    res.json(buildState(next.recentPaths ?? [], next.homePath ?? null));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

/** DELETE /api/snaglet-home/saved — remove a path from the registry */
snagletHomeRouter.delete('/saved', async (req, res) => {
  const { path: removePath } = (req.body ?? {}) as { path?: string };
  if (!removePath || typeof removePath !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  try {
    // Match against the canonical form so a case/symlink-variant of a stored
    // path still removes the right entry.
    const canonical = await canonicalizeHomePath(removePath.trim());
    const pointer = readSnagletPointer();
    const next: SnagletPointer = {
      homePath: pointer.homePath,
      recentPaths: (pointer.recentPaths ?? []).filter((p) => p !== removePath && p !== canonical),
    };
    await writePointer(next);
    res.json(buildState(next.recentPaths ?? [], next.homePath ?? null));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});
