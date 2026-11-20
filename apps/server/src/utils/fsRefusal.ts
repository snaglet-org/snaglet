import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';

/**
 * A clear 4xx for a rename the file system refused for a reason the person can
 * act on (a locked file, missing permission, a read-only disk, a file in use),
 * or null for anything else. The message names the file, never its full path.
 */
export function renameRefusal(err: unknown, name: string): AppError | null {
  switch ((err as NodeJS.ErrnoException | null)?.code) {
    case 'EACCES':
    case 'EPERM':
      return new AppError(
        `Snaglet is not allowed to rename "${name}". The file may be locked, or Snaglet may lack permission for its folder.`,
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    case 'EROFS':
      return new AppError(
        `"${name}" is on a read-only disk, so it cannot be renamed.`,
        ErrorCode.FORBIDDEN,
        HTTP_STATUS.FORBIDDEN
      );
    case 'EBUSY':
      return new AppError(
        `"${name}" is in use. Close it and try again.`,
        ErrorCode.CONFLICT,
        HTTP_STATUS.CONFLICT
      );
    default:
      return null;
  }
}
