import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

type ShareRole = 'reader' | 'writer' | 'commenter' | 'owner';
type ShareType = 'user' | 'group' | 'domain' | 'anyone';

interface ShareArgs {
  fileId: string;
  role?: ShareRole;
  type?: ShareType;
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
}

const VALID_ROLES: ShareRole[] = ['reader', 'writer', 'commenter', 'owner'];
const VALID_TYPES: ShareType[] = ['user', 'group', 'domain', 'anyone'];

export default async function googleDriveShareFile(
  args: ShareArgs,
  _context: ToolHandlerContext
): Promise<string> {
  const { fileId, emailAddress, domain, sendNotificationEmail } = args;
  const role: ShareRole = args.role ?? 'reader';
  const type: ShareType = args.type ?? 'user';

  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if ((type === 'user' || type === 'group') && !emailAddress) {
    throw new Error(`emailAddress is required when type is '${type}'`);
  }
  if (type === 'domain' && !domain) {
    throw new Error("domain is required when type is 'domain'");
  }

  const auth = await getGoogleClient();
  const drive = google.drive({ version: 'v3', auth });

  const permission: drive_v3.Schema$Permission = { role, type };
  if (type === 'user' || type === 'group') permission.emailAddress = emailAddress;
  if (type === 'domain') permission.domain = domain;

  // Google requires a notification email for user/group grants unless the
  // caller explicitly opts out. For type 'anyone' there is no recipient, so
  // notification is forced off.
  const notify =
    type === 'anyone' ? false : sendNotificationEmail === undefined ? true : sendNotificationEmail;

  const created = await drive.permissions.create({
    fileId,
    sendNotificationEmail: notify,
    fields: 'id, role, type, emailAddress, domain',
    requestBody: permission,
  });

  const perm = created.data as drive_v3.Schema$Permission;

  // Fetch the file's webViewLink so the caller gets a usable URL back.
  let shareLink: string | undefined;
  try {
    const meta = await drive.files.get({ fileId, fields: 'webViewLink' });
    shareLink = (meta.data as drive_v3.Schema$File).webViewLink ?? undefined;
  } catch {
    // Non-fatal — the permission was still created.
    shareLink = undefined;
  }

  return JSON.stringify({
    fileId,
    permissionId: perm.id,
    role: perm.role,
    type: perm.type,
    emailAddress: perm.emailAddress ?? undefined,
    domain: perm.domain ?? undefined,
    sentNotificationEmail: notify,
    shareLink,
  });
}
