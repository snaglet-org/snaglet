import { execFile } from 'node:child_process';
import { chmod, open } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_ACL = `
$ErrorActionPreference = 'Stop'
$target = $env:SNAGLET_PG_PRIVATE_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$inheritance = if ($env:SNAGLET_PG_PRIVATE_ACL_DIRECTORY -eq '1') { 'OICI' } else { '' }
$acl = if ($env:SNAGLET_PG_PRIVATE_ACL_DIRECTORY -eq '1') { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$acl.SetSecurityDescriptorSddlForm(('D:P(A;' + $inheritance + ';FA;;;' + $sid + ')'), [System.Security.AccessControl.AccessControlSections]::Access)
if ($env:SNAGLET_PG_PRIVATE_ACL_DIRECTORY -eq '1') { [System.IO.Directory]::SetAccessControl($target, $acl) } else { [System.IO.File]::SetAccessControl($target, $acl) }
`;

/** Set an exact owner-only DACL, including when a file had explicit grants. */
export async function restrictPostgresPath(target: string, directory = false): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(target, directory ? 0o700 : 0o600);
    return;
  }
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_PRIVATE_ACL, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        SNAGLET_PG_PRIVATE_ACL_PATH: target,
        SNAGLET_PG_PRIVATE_ACL_DIRECTORY: directory ? '1' : '0',
      },
    }
  );
}

export async function syncPostgresDirectory(directoryPath: string): Promise<void> {
  // Windows cannot open directories through Node's fs API. Marker file data is
  // still flushed before atomic rename; POSIX additionally flushes its parent.
  if (process.platform === 'win32') return;
  const directory = await open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
