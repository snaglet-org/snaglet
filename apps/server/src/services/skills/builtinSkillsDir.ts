/**
 * Where Snaglet's built-in skills live on disk. They ship with the server, not in
 * the user's home, so an update brings new versions with no copy step and a
 * user's own ~/.snaglet/skills is never touched.
 *
 * Candidates, first existing wins:
 *   1. SNAGLET_BUILTIN_SKILLS_DIR (tests, custom installs)
 *   2. <bundle>/builtin-skills, beside server.mjs (desktop + server bundle;
 *      apps/server/scripts/bundle.mjs copies it there)
 *   3. <repo>/apps/server/builtin-skills, walking up from this module (source
 *      checkout under tsx/jest, or the tsc build in dist/server)
 */
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR_NAME = 'builtin-skills';

export function builtinSkillsDirCandidates(moduleUrl: string = import.meta.url): string[] {
  const fromEnv = process.env.SNAGLET_BUILTIN_SKILLS_DIR?.trim();
  if (fromEnv) return [fromEnv];
  const candidates = [path.join(path.dirname(process.argv[1] ?? ''), DIR_NAME)];
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'apps', 'server', DIR_NAME));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/** The built-in skills folder, or null when this install has none. */
export function resolveBuiltinSkillsDir(moduleUrl?: string): string | null {
  return builtinSkillsDirCandidates(moduleUrl).find((dir) => existsSync(dir)) ?? null;
}
