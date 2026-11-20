import { isCursorFlower } from '@snaglet/shared/constants/agentCursor';
import { validateCursorSpec } from '@snaglet/shared/cursor';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** A real spec is under 1 KB; cap the JSON so a body can't stuff the column. */
const MAX_CURSOR_SPEC_BYTES = 4096;

/**
 * Validates the optional cursor fields of an agent create/update body.
 * `undefined` = not supplied (left alone); `null` = clear. Throws a 400 on a
 * non-flower id or a color that is not `#rrggbb`.
 */
export function validateAgentCursorFields(body: Record<string, unknown>): void {
  const { cursorFlower, cursorColor, cursorSpec } = body;
  if (cursorFlower !== undefined && cursorFlower !== null && !isCursorFlower(cursorFlower)) {
    throw new AppError(
      'cursorFlower must be a known flower id or null',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (
    cursorColor !== undefined &&
    cursorColor !== null &&
    !(typeof cursorColor === 'string' && HEX_COLOR.test(cursorColor))
  ) {
    throw new AppError(
      'cursorColor must be a #rrggbb hex color or null',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (cursorSpec !== undefined && cursorSpec !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(cursorSpec);
    } catch {
      json = undefined;
    }
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_CURSOR_SPEC_BYTES) {
      throw new AppError(
        `cursorSpec must be JSON of at most ${MAX_CURSOR_SPEC_BYTES} bytes`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    try {
      validateCursorSpec(cursorSpec);
    } catch (err) {
      throw new AppError(
        getErrorMessage(err, 'cursorSpec is invalid'),
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
  }
}
