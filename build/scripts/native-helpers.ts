/**
 * Native helper manifest contract shared by the desktop verifiers and the
 * packaged-app smoke.
 *
 * `apps/server/scripts/bundle.mjs` writes `native/helpers.json` beside
 * `server.mjs` describing every macOS helper it built and staged. Verification
 * re-reads that manifest from inside the packaged .app and proves the shipped
 * set is the asserted one: required helpers are `bundled`, and every entry's
 * status agrees with the files actually present.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type NativeHelperPolicy = 'required' | 'best-effort';
export type NativeHelperStatus = 'bundled' | 'skipped';

export interface NativeHelperEntry {
  policy: NativeHelperPolicy;
  /** Bundle-relative executable path, e.g. `native/apple-stt/bin/snaglet-apple-stt`. */
  executable: string;
  status: NativeHelperStatus;
  /** Why a helper was skipped (`nonDarwin`, `sdkTooOld`, `buildFailed`, `notBuilt`). */
  reason?: string;
}

export interface NativeHelpersManifest {
  schemaVersion: 1;
  profile: string;
  platform: string;
  /** The macOS SDK the helpers were built against, null when unknown or not built. */
  macosSdk: string | null;
  helpers: Record<string, NativeHelperEntry>;
}

interface KnownNativeHelper {
  policy: NativeHelperPolicy;
  executable: string;
  /** Oldest macOS SDK major version that declares the helper's APIs. */
  minimumSdk?: number;
}

/**
 * The complete helper set a server bundle records, bound to policy and
 * executable path. Mirrors NATIVE_HELPERS in apps/server/scripts/lib/nativeHelpers.mjs;
 * tests/build/native-helpers.test.ts proves the two tables agree.
 */
export const KNOWN_NATIVE_HELPERS: Readonly<Record<string, KnownNativeHelper>> = Object.freeze({
  'apple-stt': {
    policy: 'required',
    executable: 'native/apple-stt/bin/snaglet-apple-stt',
    minimumSdk: 26,
  },
  'apple-tts': { policy: 'required', executable: 'native/apple-tts/bin/snaglet-apple-tts' },
  'nlp-helper': { policy: 'required', executable: 'native/nlp-helper/bin/snaglet-nlp-helper' },
  'apple-chat': { policy: 'best-effort', executable: 'native/apple-chat/bin/snaglet-apple-chat' },
  'cursor-overlay': {
    policy: 'best-effort',
    executable: 'native/cursor-overlay/bin/snaglet-cursor-overlay',
  },
});

/** Helpers a macOS desktop bundle must ship. */
export const REQUIRED_NATIVE_HELPERS: readonly string[] = Object.freeze(
  Object.entries(KNOWN_NATIVE_HELPERS)
    .filter(([, helper]) => helper.policy === 'required')
    .map(([name]) => name)
);

/** Helpers a macOS desktop bundle records but may legitimately skip. */
export const BEST_EFFORT_NATIVE_HELPERS: readonly string[] = Object.freeze(
  Object.entries(KNOWN_NATIVE_HELPERS)
    .filter(([, helper]) => helper.policy === 'best-effort')
    .map(([name]) => name)
);

const HELPER_NAME = /^[a-z0-9-]+$/;
const EXECUTABLE_PATH = /^native\/[a-z0-9-]+\/bin\/[a-z0-9-]+$/;
const SDK_VERSION = /^(\d+)(\.\d+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the manifest shape without trusting any field. */
export function parseNativeHelpersManifest(value: unknown): NativeHelpersManifest {
  if (!isRecord(value)) throw new Error('native helper manifest is not an object');
  if (value.schemaVersion !== 1) throw new Error('native helper manifest schemaVersion is not 1');
  if (typeof value.profile !== 'string' || typeof value.platform !== 'string') {
    throw new Error('native helper manifest is missing profile/platform');
  }
  if (!isRecord(value.helpers)) throw new Error('native helper manifest has no helpers table');
  const macosSdk = value.macosSdk ?? null;
  if (macosSdk !== null && (typeof macosSdk !== 'string' || !SDK_VERSION.test(macosSdk))) {
    throw new Error('native helper manifest has an invalid macosSdk');
  }
  const helpers: Record<string, NativeHelperEntry> = {};
  for (const [name, raw] of Object.entries(value.helpers)) {
    if (!HELPER_NAME.test(name))
      throw new Error(`native helper manifest has an invalid helper name: ${name}`);
    if (!isRecord(raw)) throw new Error(`native helper manifest entry is not an object: ${name}`);
    if (raw.policy !== 'required' && raw.policy !== 'best-effort') {
      throw new Error(`native helper manifest entry has an invalid policy: ${name}`);
    }
    if (raw.status !== 'bundled' && raw.status !== 'skipped') {
      throw new Error(`native helper manifest entry has an invalid status: ${name}`);
    }
    if (typeof raw.executable !== 'string' || !EXECUTABLE_PATH.test(raw.executable)) {
      throw new Error(`native helper manifest entry has an invalid executable path: ${name}`);
    }
    if (raw.reason !== undefined && typeof raw.reason !== 'string') {
      throw new Error(`native helper manifest entry has an invalid reason: ${name}`);
    }
    helpers[name] = {
      policy: raw.policy,
      executable: raw.executable,
      status: raw.status,
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
    };
  }
  return {
    schemaVersion: 1,
    profile: value.profile,
    platform: value.platform,
    macosSdk,
    helpers,
  };
}

/**
 * True when a manifest entry was skipped because the build's SDK predates the
 * helper's APIs and the manifest's own SDK version bears that out.
 */
function skippedForOldSdk(
  entry: NativeHelperEntry,
  expected: KnownNativeHelper,
  macosSdk: string | null
): boolean {
  if (entry.status !== 'skipped' || entry.reason !== 'sdkTooOld') return false;
  const major = macosSdk === null ? null : Number(SDK_VERSION.exec(macosSdk)?.[1]);
  return expected.minimumSdk !== undefined && major !== null && major < expected.minimumSdk;
}

/** One line per helper the build skipped because its SDK predates the helper's APIs. */
export function describeSdkSkippedHelpers(
  manifest: NativeHelpersManifest,
  known: Readonly<Record<string, KnownNativeHelper>> = KNOWN_NATIVE_HELPERS
): string[] {
  return Object.entries(manifest.helpers).flatMap(([name, entry]) => {
    const expected = known[name];
    if (!expected || !skippedForOldSdk(entry, expected, manifest.macosSdk)) return [];
    return [
      `${name} is not bundled: built with the macOS ${manifest.macosSdk} SDK, it needs the macOS ${expected.minimumSdk} SDK`,
    ];
  });
}

/**
 * Prove the manifest describes the staged server bundle at `serverRoot` and
 * matches the known helper set exactly: every known helper is recorded with
 * its expected policy and executable path (an entry pointing at another
 * helper's binary, or an omitted best-effort helper, is a lying manifest);
 * every required helper is bundled, unless the recorded SDK predates its APIs;
 * every bundled entry's executable exists; and every skipped entry's
 * executable is absent.
 */
export function assertNativeHelpers(
  manifest: unknown,
  serverRoot: string,
  known: Readonly<Record<string, KnownNativeHelper>> = KNOWN_NATIVE_HELPERS,
  fileExists: (absolute: string) => boolean = (absolute) =>
    existsSync(absolute) && statSync(absolute).isFile()
): NativeHelpersManifest {
  const parsed = parseNativeHelpersManifest(manifest);
  for (const [name, expected] of Object.entries(known)) {
    const entry = parsed.helpers[name];
    if (!entry) throw new Error(`Native helper is not recorded in the manifest: ${name}`);
    if (entry.policy !== expected.policy) {
      throw new Error(
        `Native helper ${name} is recorded as ${entry.policy}; expected ${expected.policy}`
      );
    }
    if (entry.executable !== expected.executable) {
      throw new Error(
        `Native helper ${name} is bound to ${entry.executable}; expected ${expected.executable}`
      );
    }
    if (
      expected.policy === 'required' &&
      entry.status !== 'bundled' &&
      !skippedForOldSdk(entry, expected, parsed.macosSdk)
    ) {
      throw new Error(
        `Required native helper is missing from the bundle: ${name} (${entry.reason ?? 'skipped'}` +
          `${entry.reason === 'sdkTooOld' ? `, macOS SDK ${parsed.macosSdk ?? 'unknown'}` : ''})`
      );
    }
  }
  for (const [name, entry] of Object.entries(parsed.helpers)) {
    if (!(name in known))
      throw new Error(`Native helper manifest records an unknown helper: ${name}`);
    const present = fileExists(path.join(serverRoot, entry.executable));
    if (entry.status === 'bundled' && !present) {
      throw new Error(`Native helper recorded as bundled is missing: ${entry.executable}`);
    }
    if (entry.status === 'skipped' && present) {
      throw new Error(`Native helper recorded as skipped is present: ${entry.executable}`);
    }
  }
  return parsed;
}

/** Where the packaged server keeps chokidar's macOS file-event add-on. */
export const FSEVENTS_NODE_PATH = path.join('node_modules', 'fsevents', 'fsevents.node');

/**
 * macOS builds must ship fsevents: without it chokidar falls back to a polling
 * watch mode that stats every watched file (~45% idle CPU). Other platforms legitimately omit it (fs.watch is used).
 */
export function assertPackagedFsevents(
  serverRoot: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (absolute: string) => boolean = (absolute) =>
    existsSync(absolute) && statSync(absolute).isFile()
): void {
  if (platform !== 'darwin') return;
  if (!fileExists(path.join(serverRoot, FSEVENTS_NODE_PATH))) {
    throw new Error(
      `Packaged server is missing fsevents (chokidar would poll): ${FSEVENTS_NODE_PATH}`
    );
  }
}
