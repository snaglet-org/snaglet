import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Deploy the licensed MSVC redistributable DLLs beside each native executable. */
export function stageWindowsCrt(destinations) {
  if (process.platform !== 'win32') return [];
  const roots = [];
  if (process.env.VCToolsRedistDir) roots.push(process.env.VCToolsRedistDir);
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe'
  );
  if (existsSync(vswhere)) {
    const result = spawnSync(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-version',
        '[17.0,18.0)',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      }
    );
    if (result.status === 0 && result.stdout.trim()) {
      const redist = path.join(result.stdout.trim(), 'VC/Redist/MSVC');
      if (existsSync(redist)) {
        roots.push(
          ...readdirSync(redist)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((version) => path.join(redist, version))
        );
      }
    }
  }
  const source = roots
    .map((root) => path.join(root, 'x64/Microsoft.VC143.CRT'))
    .find((candidate) => existsSync(path.join(candidate, 'vcruntime140.dll')));
  if (!source)
    throw new Error(
      'Windows packaging requires the Visual Studio 2022 x64 CRT redistributable directory (VCToolsRedistDir). Install Desktop development with C++.'
    );
  const files = readdirSync(source)
    .filter((file) => file.endsWith('.dll'))
    .sort();
  for (const required of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    if (!files.includes(required)) throw new Error(`Windows CRT is incomplete: ${required}`);
  }
  for (const destination of destinations) {
    for (const file of files) cpSync(path.join(source, file), path.join(destination, file));
  }
  return files;
}
