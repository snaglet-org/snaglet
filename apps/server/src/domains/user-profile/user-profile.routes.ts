/**
 * User Profile API routes
 *
 * GET    /api/user-profile            — get the active user's profile
 * GET    /api/user-profile/users      — list all users (options for the identity picker)
 * POST   /api/user-profile/users      — create a local user, optionally making it active
 * POST   /api/user-profile/active/:id — mark a user as the active desktop user
 * PATCH  /api/user-profile            — update the active user's profile (name, email)
 *
 * Image fields (avatar/header) are not currently stored; avatar upload is a
 * planned feature — see the agent profile model for the intended extension point.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { Users } from '@snaglet/db/tables/users';
import type { UpdateUserInput } from '@snaglet/db/tables/users';
import { AppError } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import {
  USER_NAME_MAX_LENGTH,
  isDefaultUserName,
  isReservedActorName,
} from '@snaglet/shared/constants';

const router = Router();
const MAX_EMAIL_LENGTH = 254;
const MAX_PICTURE_LENGTH = 2048;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validation(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

function conflict(message: string): AppError {
  return new AppError(message, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT);
}

function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw validation('Name is required');
  if (name.length > USER_NAME_MAX_LENGTH) {
    throw validation(`Name must be ${USER_NAME_MAX_LENGTH} characters or fewer`);
  }
  if (isReservedActorName(name) || isDefaultUserName(name)) {
    throw validation('That name is reserved and cannot be used');
  }
  return name;
}

function validateOptionalEmail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const email = typeof value === 'string' ? value.trim() : '';
  if (!email) return undefined;
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    throw validation('Invalid email format');
  }
  return email;
}

function validateOptionalPicture(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const picture = typeof value === 'string' ? value.trim() : '';
  if (!picture) return null;
  if (picture.length > MAX_PICTURE_LENGTH) {
    throw validation(`Picture URL must be ${MAX_PICTURE_LENGTH} characters or fewer`);
  }
  try {
    const parsed = new URL(picture);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw validation('Picture must be a valid http(s) URL');
  }
  return picture;
}

function isDuplicateUserError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code?: unknown }).code === 'USER_DUPLICATE_NAME' ||
      (err as { code?: unknown }).code === '23505')
  );
}

/** Resolve the current active user id, falling back to 'local_user'. */
async function resolveActiveUserId(): Promise<string> {
  const active = await Users.getActiveUser();
  if (active) return active.id;
  const first = await Users.findById('local_user');
  return first?.id ?? 'local_user';
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const id = await resolveActiveUserId();
    const row = await Users.findById(id);
    if (!row) {
      throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

// List all users — options for the identity picker (settings → profile).
router.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const rows = await Users.list({ orderBy: 'id', order: 'ASC' });
    sendOk(res, rows);
  })
);

router.post(
  '/users',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = validateName(body.name);
    const email = validateOptionalEmail(body.email);
    const picture = validateOptionalPicture(body.picture);

    if (body.make_active !== undefined && typeof body.make_active !== 'boolean') {
      throw validation('make_active must be a boolean');
    }
    if (body.makeActive !== undefined && typeof body.makeActive !== 'boolean') {
      throw validation('makeActive must be a boolean');
    }
    const makeActive = Boolean(body.make_active ?? body.makeActive ?? false);

    const existing = await Users.findByName(name);
    if (existing) throw conflict('A user with that name already exists');

    try {
      const row = await Users.createLocalUser({ name, email, picture, makeActive });
      sendOk(res, row);
    } catch (err) {
      if (isDuplicateUserError(err)) {
        throw conflict('A user with that name already exists');
      }
      throw err;
    }
  })
);

// Mark a user as the active desktop user. Clears the active flag on all others.
router.post(
  '/active/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || id.trim() === '') {
      throw new AppError('Invalid user id', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const row = await Users.setActiveUser(id);
    if (!row) {
      throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

router.patch(
  '/',
  asyncHandler(async (req, res) => {
    const id = await resolveActiveUserId();
    const { name, email } = req.body as Record<string, unknown>;

    if (email !== undefined) {
      const value = typeof email === 'string' ? email.trim() : '';
      if (value && !EMAIL_RE.test(value)) {
        throw new AppError(
          'Invalid email format',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

    // "ghost" (the system attribution actor) and "system" (its hook label) are
    // reserved across both principal kinds — no human user may be named either
    // (keeps author names unambiguous and unspoofable). Case-insensitive.
    if (name !== undefined && isReservedActorName(typeof name === 'string' ? name : '')) {
      throw new AppError(
        '"ghost" and "system" are reserved system names and cannot be used',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const input: UpdateUserInput = {};
    if (name !== undefined) {
      // The same rules a new user's name meets — except that the profile may
      // keep the name it already has (the starting `DEFAULT_USER_NAME` included).
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw validation('Name is required');
      if (trimmed.length > USER_NAME_MAX_LENGTH) {
        throw validation(`Name must be ${USER_NAME_MAX_LENGTH} characters or fewer`);
      }
      const holder = await Users.findByName(trimmed);
      if (holder && holder.id !== id) throw conflict('A user with that name already exists');
      input.name = trimmed;
    }
    if (email !== undefined) input.email = typeof email === 'string' ? email.trim() : '';

    if (Object.keys(input).length === 0) {
      throw new AppError(
        'No fields to update',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const row = await Users.update(id, input);
    if (!row) {
      throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, row);
  })
);

export default router;
