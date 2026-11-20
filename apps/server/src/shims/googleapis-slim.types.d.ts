/**
 * Types-only stand-in for `googleapis`, used only by tsconfig.typecheck.json.
 *
 * `import ... from 'googleapis'` makes tsc load the package index, which
 * references all ~330 API clients (~917 files, ~30% of the server program).
 * Snaglet uses six, so typecheck maps `googleapis` here and re-exports just those.
 * Runtime is untouched: dev/tsx use the real package, the bundle uses
 * googleapis-slim.ts.
 *
 * Using another Google API? Add its export here and in googleapis-slim.ts.
 */
import type { AuthPlus } from 'googleapis-common';
import { calendar, calendar_v3 } from 'googleapis/build/src/apis/calendar';
import { docs, docs_v1 } from 'googleapis/build/src/apis/docs';
import { drive, drive_v3 } from 'googleapis/build/src/apis/drive';
import { gmail, gmail_v1 } from 'googleapis/build/src/apis/gmail';
import { oauth2, oauth2_v2 } from 'googleapis/build/src/apis/oauth2';
import { sheets, sheets_v4 } from 'googleapis/build/src/apis/sheets';

export { calendar_v3, docs_v1, drive_v3, gmail_v1, oauth2_v2, sheets_v4 };

export declare const google: {
  auth: AuthPlus;
  calendar: typeof calendar;
  docs: typeof docs;
  drive: typeof drive;
  gmail: typeof gmail;
  oauth2: typeof oauth2;
  sheets: typeof sheets;
};
