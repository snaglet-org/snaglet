import path from 'node:path';
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { safeJsonParse } from '@snaglet/shared/utils';

export const DEFAULT_PROFILE = 'main';
export const TEMP_PROFILE = 'temp';
const ID_RE = /^[a-z0-9-]{1,32}$/;
const META = '.snaglet-profile.json';

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
  }
}

const isValidProfileId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

export function assertProfileId(id: unknown): string {
  if (!isValidProfileId(id)) {
    throw new ProfileError('profile id must be 1-32 chars of a-z, 0-9 and "-"', 400);
  }
  return id;
}

const profilesRoot = (home: string) => path.join(home, 'browser-profiles');

/** Resolve a profile dir and prove it sits directly inside <home>/browser-profiles. */
export function profileDir(home: string, id: string): string {
  assertProfileId(id);
  const root = path.resolve(profilesRoot(home));
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root)
    throw new ProfileError('profile path escapes the profiles root', 400);
  return dir;
}

/** "Work Gmail" -> "work-gmail". */
function slugifyProfileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return assertProfileId(slug);
}

export interface ProfileSummary {
  id: string;
  name: string;
  exists: boolean;
  running: boolean;
  lastUsedAt: number | null;
}

async function readMeta(dir: string): Promise<{ name?: string; lastUsedAt?: number }> {
  try {
    return safeJsonParse(await readFile(path.join(dir, META), 'utf8'), {});
  } catch {
    return {};
  }
}

export async function touchProfileMeta(home: string, id: string, name?: string): Promise<void> {
  const dir = profileDir(home, id);
  await mkdir(dir, { recursive: true });
  const meta = await readMeta(dir);
  await writeFile(
    path.join(dir, META),
    JSON.stringify({ name: meta.name ?? name ?? id, lastUsedAt: Date.now() })
  );
}

export async function listProfiles(
  home: string,
  isRunning: (id: string) => boolean
): Promise<ProfileSummary[]> {
  const root = profilesRoot(home);
  let ids: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory() && isValidProfileId(e.name)).map((e) => e.name);
  } catch {
    ids = [];
  }
  if (!ids.includes(DEFAULT_PROFILE)) ids.unshift(DEFAULT_PROFILE);
  const out: ProfileSummary[] = [];
  for (const id of ids.sort()) {
    const dir = profileDir(home, id);
    const exists = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false
    );
    const meta = exists ? await readMeta(dir) : {};
    out.push({
      id,
      name: meta.name ?? id,
      exists,
      running: isRunning(id),
      lastUsedAt: meta.lastUsedAt ?? null,
    });
  }
  return out;
}

export async function createProfile(home: string, name: string): Promise<ProfileSummary> {
  if (typeof name !== 'string' || !name.trim()) throw new ProfileError('name is required', 400);
  const id = slugifyProfileName(name.trim());
  if (id === TEMP_PROFILE) throw new ProfileError('"temp" is reserved', 400);
  const dir = profileDir(home, id);
  const exists = await stat(dir).then(
    () => true,
    () => false
  );
  if (exists) throw new ProfileError(`profile "${id}" already exists`, 409);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, META), JSON.stringify({ name: name.trim(), lastUsedAt: null }));
  return { id, name: name.trim(), exists: true, running: false, lastUsedAt: null };
}

export async function deleteProfile(
  home: string,
  id: string,
  isRunning: (id: string) => boolean
): Promise<void> {
  const dir = profileDir(home, id);
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory()) throw new ProfileError(`unknown profile "${id}"`, 404);
  if (isRunning(id)) throw new ProfileError(`profile "${id}" is running; close it first`, 409);
  await rm(dir, { recursive: true, force: true });
}
