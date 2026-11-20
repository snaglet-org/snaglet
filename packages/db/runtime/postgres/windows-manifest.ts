import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Per-process UTF-8 supports Unicode argv and narrow UCRT file APIs without
// changing the user's system locale. Requires Windows 10 version 1903+.
const WINDOWS_UTF8_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage></windowsSettings></application>
</assembly>
`;

/** Inspect resource IDs, avoiding localized mt.exe errors when no manifest exists. */
export function hasEmbeddedApplicationManifest(image: Buffer): boolean {
  const u16 = (offset: number): number => image.readUInt16LE(offset);
  const u32 = (offset: number): number => image.readUInt32LE(offset);
  if (image.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error('Invalid PE signature');
  const optional = pe + 24;
  const magic = u16(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Invalid PE optional header');
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const resourceRva = u32(directories + 16);
  if (resourceRva === 0) return false;
  const sections = optional + u16(pe + 20);
  let resourceOffset: number | undefined;
  for (let index = 0; index < u16(pe + 6); index++) {
    const section = sections + index * 40;
    const virtualAddress = u32(section + 12);
    const rawSize = u32(section + 16);
    if (resourceRva >= virtualAddress && resourceRva - virtualAddress < rawSize) {
      resourceOffset = u32(section + 20) + resourceRva - virtualAddress;
      break;
    }
  }
  if (resourceOffset === undefined) throw new Error('Invalid PE resource address');
  const findId = (directory: number, id: number): number | undefined => {
    const count = u16(directory + 12) + u16(directory + 14);
    for (let index = 0; index < count; index++) {
      const entry = directory + 16 + index * 8;
      if (u32(entry) === id) return u32(entry + 4);
    }
    return undefined;
  };
  const type = findId(resourceOffset, 24); // RT_MANIFEST
  if (type === undefined) return false;
  if (!(type & 0x80000000)) throw new Error('Invalid PE manifest directory');
  return findId(resourceOffset + (type & 0x7fffffff), 1) !== undefined;
}

export async function applyWindowsUtf8Manifests(
  binDir: string,
  executableNames: readonly string[],
  buildDir: string,
  environment: NodeJS.ProcessEnv
): Promise<Record<string, string>> {
  const sdk = environment.WINDOWSSDKDIR;
  const version = environment.WINDOWSSDKVERSION;
  if (!sdk || !version) throw new Error('Windows SDK environment is missing for UTF-8 manifests');
  const mt = path.join(sdk, 'bin', version, 'x64', 'mt.exe');
  await access(mt).catch(() => {
    throw new Error(`Windows SDK manifest tool is missing: ${mt}`);
  });
  const patch = path.join(buildDir, 'snaglet-postgres-utf8.manifest');
  await writeFile(patch, WINDOWS_UTF8_MANIFEST, 'utf8');
  const hashes: Record<string, string> = {};
  for (const name of executableNames) {
    const executable = path.join(binDir, name);
    const original = path.join(buildDir, `${name}.original.manifest`);
    const manifests = [patch];
    const run = async (args: string[]): Promise<void> => {
      await execFileAsync(mt, ['-nologo', ...args], {
        env: environment,
        windowsHide: true,
        timeout: 60_000,
      });
    };
    if (hasEmbeddedApplicationManifest(await readFile(executable))) {
      await run([`-inputresource:${executable};#1`, `-out:${original}`]);
      manifests.unshift(original);
    }
    await run(['-manifest', ...manifests, `-outputresource:${executable};#1`]);
    const verified = path.join(buildDir, `${name}.verified.manifest`);
    await run([`-inputresource:${executable};#1`, `-out:${verified}`]);
    const content = await readFile(verified, 'utf8');
    if (!/<(?:\w+:)?activeCodePage\b[^>]*>UTF-8<\//.test(content)) {
      throw new Error(`UTF-8 manifest verification failed for ${name}`);
    }
    hashes[name] = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
  }
  return hashes;
}
