/**
 * googleapis-slim — bundle-time replacement for the `googleapis` package.
 *
 * `import { google } from 'googleapis'` pulls the package index, which
 * statically requires all ~330 Google API clients (≈34MB of bundled JS —
 * 95% of the server bundle, blowing the 20MB budget). Snaglet uses six.
 *
 * The bundle build (scripts/bundle.mjs) aliases `googleapis` → this module;
 * dev/tsc keep the real package, so type imports (`calendar_v3` etc.) are
 * unaffected. The `google` object exposes exactly the surface Snaglet touches:
 * google.auth + the six API factories. A Proxy throws a descriptive error
 * for any API that was never wired in, so drift fails loudly at the call
 * site instead of silently returning undefined.
 *
 * Adding a Google API to the server? Add its import + entry here, or the
 * bundled desktop app won't have it.
 */

// @ts-nocheck — internal googleapis build paths have no type declarations.
import { calendar } from 'googleapis/build/src/apis/calendar';
import { docs } from 'googleapis/build/src/apis/docs';
import { drive } from 'googleapis/build/src/apis/drive';
import { gmail } from 'googleapis/build/src/apis/gmail';
import { oauth2 } from 'googleapis/build/src/apis/oauth2';
import { sheets } from 'googleapis/build/src/apis/sheets';
// AuthPlus from googleapis-common — importing it via build/src/googleapis
// would drag in the full ~330-API index this shim exists to avoid.
import { AuthPlus } from 'googleapis-common';

const apis = { calendar, docs, drive, gmail, oauth2, sheets };

const base = {
  auth: new AuthPlus(),
  ...Object.fromEntries(
    Object.entries(apis).map(([name, factory]) => [
      name,
      // googleapis binds API factories to the google instance for shared options.
      (...args) => factory.apply(base, args),
    ])
  ),
};

export const google = new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string') {
      throw new Error(
        `googleapis-slim: google.${prop} is not in the server bundle. ` +
          `Add it to apps/server/src/shims/googleapis-slim.ts.`
      );
    }
    return undefined;
  },
});
