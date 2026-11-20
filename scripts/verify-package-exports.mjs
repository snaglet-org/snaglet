#!/usr/bin/env node
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  { directory: 'shared', name: '@snaglet/shared' },
  { directory: 'db', name: '@snaglet/db' },
  { directory: 'snaglet-sdk', name: '@snaglet/sdk' },
];
const tempRoot = join(repoRoot, 'dist', '.package-exports-smoke');
const tempModules = join(tempRoot, 'node_modules', '@snaglet');

await rm(tempRoot, { recursive: true, force: true });

try {
  await mkdir(tempModules, { recursive: true });
  for (const packageInfo of packages) {
    const sourceManifest = JSON.parse(
      await readFile(join(repoRoot, 'packages', packageInfo.directory, 'package.json'), 'utf8')
    );
    const compiledDirectory = join(repoRoot, 'dist', packageInfo.directory);
    const stagedDirectory = join(tempModules, packageInfo.name.split('/')[1]);
    await access(join(compiledDirectory, 'index.js'));
    await cp(compiledDirectory, stagedDirectory, { recursive: true });
    const exportsMap = Object.fromEntries(
      Object.entries(sourceManifest.exports).map(([specifier, target]) => [
        specifier,
        target.replace(/\.ts$/, '.js'),
      ])
    );
    await writeFile(
      join(stagedDirectory, 'package.json'),
      JSON.stringify({ name: packageInfo.name, type: 'module', exports: exportsMap }, null, 2)
    );
  }
  // @snaglet/theme ships committed JavaScript, CSS and JSON, no build: stage the
  // files its manifest publishes, as they are.
  const themeDirectory = join(repoRoot, 'packages', 'theme');
  const themeManifest = JSON.parse(await readFile(join(themeDirectory, 'package.json'), 'utf8'));
  for (const file of [...themeManifest.files, 'package.json'])
    await cp(join(themeDirectory, file), join(tempModules, 'theme', file));

  const entry = join(tempRoot, 'verify.mjs');
  await writeFile(
    entry,
    [
      "await import('@snaglet/shared');",
      "await import('@snaglet/shared/constants');",
      "await import('@snaglet/db');",
      "await import('@snaglet/db/db');",
      "await import('@snaglet/db/actorMember');",
      "await import('@snaglet/db/adapters/postgres');",
      "await import('@snaglet/db/migrations');",
      "await import('@snaglet/db/runtime/postgres/binaries');",
      "await import('@snaglet/db/runtime/postgres/runtime');",
      "await import('@snaglet/db/runtime/postgres/version');",
      "await import('@snaglet/sdk');",
      "const theme = await import('@snaglet/theme');",
      "if (theme.defaultTheme.background !== '#0a0a0a') throw new Error('@snaglet/theme default');",
      "await import('@snaglet/theme/defaultTheme.json', { with: { type: 'json' } });",
      "console.log('compiled package exports verified');",
    ].join('\n')
  );
  await import(pathToFileURL(entry).href);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
