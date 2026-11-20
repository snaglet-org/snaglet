import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  removeLegacySdkCopy,
  SDK_TYPE_DECLARATIONS,
} from '@server/services/ToolService/customTools/vendorSdk';

function tsconfig(hooksDir: string, sdkTypesDir: string): string {
  const relativeTypes = path.relative(hooksDir, path.join(sdkTypesDir, 'index.d.ts'));
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        baseUrl: '.',
        paths: { '@snaglet/sdk': [relativeTypes] },
      },
      include: ['**/*.ts'],
      exclude: ['.snaglet-build', 'node_modules'],
    },
    null,
    2
  )}\n`;
}

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, 'utf-8')) === content) return;
  } catch {
    // Missing file.
  }
  await writeFile(filePath, content, 'utf-8');
}

export async function ensureHookAuthoringSupport(
  hooksDir: string,
  sdkTypesDir: string
): Promise<void> {
  await Promise.all([
    mkdir(hooksDir, { recursive: true }),
    mkdir(sdkTypesDir, { recursive: true }),
  ]);
  await writeIfChanged(path.join(sdkTypesDir, 'index.d.ts'), SDK_TYPE_DECLARATIONS.trimStart());
  const entries = await readdir(hooksDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => removeLegacySdkCopy(path.join(hooksDir, entry.name)))
  );
  try {
    await readFile(path.join(hooksDir, 'tsconfig.json'), 'utf-8');
  } catch {
    await writeFile(path.join(hooksDir, 'tsconfig.json'), tsconfig(hooksDir, sdkTypesDir), 'utf-8');
  }
}
