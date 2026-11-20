/**
 * The two project-id parsers share one rule set: trimmed, non-empty, no
 * control characters. `none` (any case) is the list filter's value only; a
 * link body says `null`, so `none` there is a 400 that points at `null`.
 */
import { describe, expect, it } from '@jest/globals';
import {
  parseTableProjectFilter,
  parseTableProjectId,
} from '@server/domains/tables/tableValidation';

const PROJECT_ID = 'container-3333333333333-project1';

function refusal(run: () => unknown): { statusCode?: number; message?: string } {
  try {
    run();
  } catch (err) {
    return err as { statusCode?: number; message?: string };
  }
  return {};
}

describe('project id parsing', () => {
  it('trims a project id for the filter and the body alike', () => {
    expect(parseTableProjectFilter(` ${PROJECT_ID} `)).toBe(PROJECT_ID);
    expect(parseTableProjectId(` ${PROJECT_ID} `)).toBe(PROJECT_ID);
  });

  it('distinguishes absent from null: the filter may be omitted, the body may say null', () => {
    expect(parseTableProjectFilter(undefined)).toBeUndefined();
    expect(parseTableProjectId(null)).toBeNull();
    expect(refusal(() => parseTableProjectFilter(null)).statusCode).toBe(400);
    expect(refusal(() => parseTableProjectId(undefined)).statusCode).toBe(400);
  });

  it('takes none for the filter in any case, and refuses it in a body pointing at null', () => {
    for (const value of ['none', 'NONE', ' None ']) {
      expect(parseTableProjectFilter(value)).toBe('none');
      const refused = refusal(() => parseTableProjectId(value));
      expect(refused.statusCode).toBe(400);
      expect(refused.message).toBe(
        'projectId must be a project container id or null (none is the list filter)'
      );
    }
  });

  it('rejects empty, non-string and control-character values in both', () => {
    for (const value of ['', '   ', 3, true, ['a'], { id: 'a' }]) {
      expect(refusal(() => parseTableProjectFilter(value))).toMatchObject({
        statusCode: 400,
        message: 'projectId must be a project container id or none',
      });
      expect(refusal(() => parseTableProjectId(value))).toMatchObject({
        statusCode: 400,
        message: 'projectId must be a project container id or null',
      });
    }
    for (const value of [`${PROJECT_ID}\u0000`, `${PROJECT_ID}\u001b`, `\u007f${PROJECT_ID}`]) {
      expect(refusal(() => parseTableProjectFilter(value))).toMatchObject({
        statusCode: 400,
        message: 'projectId must not contain control characters',
      });
      expect(refusal(() => parseTableProjectId(value))).toMatchObject({
        statusCode: 400,
        message: 'projectId must not contain control characters',
      });
    }
  });
});
