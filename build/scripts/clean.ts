import { rmSync } from 'node:fs';
import path from 'node:path';

const output = process.env.SNAGLET_BUILD_OUTPUT;
const distRoot = path.resolve('dist');
const target = output ? path.resolve(output) : distRoot;
const relative = path.relative(distRoot, target);
if (
  !output ||
  !relative ||
  relative === '..' ||
  relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative)
) {
  throw new Error('SNAGLET_BUILD_OUTPUT must identify a profile directory under dist/');
}

rmSync(target, { force: true, recursive: true });
console.log(`[build] removed ${output}`);
