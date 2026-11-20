import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const serverRoot = path.join(repoRoot, 'apps/server/src');
const emitModule = path.join(serverRoot, 'realtime/emit');
const surfacesDir = path.join(serverRoot, 'realtime/surfaces');
const searchRoots = ['apps', 'packages'].map((root) => path.join(repoRoot, root));
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (/\.(tsx?|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isSurfaceFile(filePath: string): boolean {
  return filePath.startsWith(`${surfacesDir}${path.sep}`);
}

function resolvesToEmit(filePath: string, specifier: string): boolean {
  if (specifier === '@server/realtime/emit' || specifier === '@server/realtime/emit.js') {
    return true;
  }
  if (!specifier.startsWith('.')) return false;

  const resolved = path.resolve(path.dirname(filePath), specifier);
  const withoutExt = resolved.replace(/\.(js|ts|mts|cts)$/, '');
  return withoutExt === emitModule;
}

const violations: Array<{ file: string; specifier: string }> = [];

for (const file of searchRoots.flatMap((root) => walk(root))) {
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (resolvesToEmit(file, specifier) && !isSurfaceFile(file)) {
      violations.push({ file: path.relative(repoRoot, file), specifier });
    }
  }
}

if (violations.length > 0) {
  console.error(
    'Direct realtime emit imports are restricted to apps/server/src/realtime/surfaces/*'
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier}`);
  }
  process.exit(1);
}

console.log('realtime import chokepoint: ok');
