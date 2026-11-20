// Native macOS helper staging policy for the server bundle (bundle.mjs).
//
// Pure: the decision of whether a helper is BUILT, STAGED, or SKIPPED is made
// here against injected `build`/`exists`/`copy` functions so the policy can be
// unit-tested without swiftc, a worktree, or a bundle on disk. bundle.mjs
// supplies the real implementations.
//
// Policies:
//   required     — built and staged, or the desktop bundle fails.
//   best-effort  — the build is always ATTEMPTED on the desktop path; a failed
//                  build is recorded as `skipped` and never falls back to a
//                  binary left behind by an earlier build (that fallback would
//                  make the shipped set depend on the machine's history).
//
// A helper with `minimumSdk` uses APIs that only that macOS SDK (or a later
// one) declares. When the build's SDK is older it is skipped with reason
// `sdkTooOld` instead of built, whatever its policy; the manifest records the
// SDK version so the verifier can check the claim. A required helper whose
// build fails on a new enough SDK, or on an SDK whose version could not be
// read, still fails the bundle.
//
// The manifest this produces (native/helpers.json) is what
// build/scripts/native-helpers.ts verifies inside the packaged app; keep the
// two tables in step.

/** @typedef {'required' | 'best-effort'} NativeHelperPolicy */
/**
 * @typedef {object} NativeHelper
 * @property {string} name          directory under apps/server/native/
 * @property {string} executable    binary name under native/<name>/bin/
 * @property {NativeHelperPolicy} policy
 * @property {number} [minimumSdk]  oldest macOS SDK major version that declares its APIs
 * @property {string} fallback      what the server does without it
 */

/** @type {readonly NativeHelper[]} */
export const NATIVE_HELPERS = Object.freeze([
  {
    name: 'apple-stt',
    executable: 'snaglet-apple-stt',
    policy: 'required',
    // SpeechAnalyzer / SpeechTranscriber; keep in step with apple-stt/build.sh.
    minimumSdk: 26,
    fallback: 'server falls back to local STT',
  },
  {
    name: 'apple-tts',
    executable: 'snaglet-apple-tts',
    policy: 'required',
    fallback: 'server falls back to local TTS',
  },
  {
    name: 'nlp-helper',
    executable: 'snaglet-nlp-helper',
    policy: 'required',
    fallback: 'message search_text stays content-only',
  },
  {
    name: 'apple-chat',
    executable: 'snaglet-apple-chat',
    policy: 'best-effort',
    fallback: 'apple-on-device provider reports notBundled and stays hidden',
  },
  {
    name: 'cursor-overlay',
    executable: 'snaglet-cursor-overlay',
    policy: 'best-effort',
    fallback: 'agent cursor flowers stay inside the Snaglet window',
  },
]);

export const NATIVE_HELPERS_MANIFEST_SCHEMA_VERSION = 1;

/** Bundle-relative executable path for a helper. */
export function nativeHelperExecutablePath(helper) {
  return `native/${helper.name}/bin/${helper.executable}`;
}

/** Major version of a macOS SDK version string (`15.4` → 15), or null. */
export function macosSdkMajor(version) {
  const match = /^(\d+)(\.\d+)*$/.exec(version?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Decide and perform the staging of one helper. Returns the manifest entry.
 *
 * @param {NativeHelper} helper
 * @param {object} io
 * @param {string} io.platform            process.platform of the build machine
 * @param {boolean} io.desktopProfile     true for desktop-* build profiles
 * @param {string | null} [io.sdkVersion] macOS SDK the helpers build against, null when unknown
 * @param {(helper: NativeHelper) => void} io.build   runs build.sh; throws on failure
 * @param {(relative: string) => boolean} io.exists   built binary present in the source tree
 * @param {(relative: string) => void} io.copy        stage the binary into the bundle
 * @param {(message: string) => void} io.log
 */
export function stageNativeHelperEntry(helper, io) {
  const relative = nativeHelperExecutablePath(helper);
  /** @type {{policy: NativeHelperPolicy, executable: string, status: 'bundled' | 'skipped', reason?: string}} */
  const entry = { policy: helper.policy, executable: relative, status: 'skipped' };
  if (io.platform !== 'darwin') {
    entry.reason = 'nonDarwin';
    return entry;
  }
  if (io.desktopProfile) {
    const sdkMajor = macosSdkMajor(io.sdkVersion);
    if (helper.minimumSdk !== undefined && sdkMajor !== null && sdkMajor < helper.minimumSdk) {
      entry.reason = 'sdkTooOld';
      io.log(
        `${helper.name} needs the macOS ${helper.minimumSdk} SDK and this build uses the macOS ` +
          `${io.sdkVersion} SDK — not built (${helper.fallback})`
      );
      return entry;
    }
    io.log(`building native/${helper.name} for desktop bundle (${helper.policy})…`);
    try {
      io.build(helper);
    } catch (error) {
      if (helper.policy === 'required') throw error;
      // Never stage a stale binary after a failed build — see header.
      entry.reason = 'buildFailed';
      const message = error instanceof Error ? error.message : String(error);
      io.log(
        `${helper.name} build failed (best-effort) — skipping (${helper.fallback}): ${message}`
      );
      return entry;
    }
  }
  if (!io.exists(relative)) {
    if (io.desktopProfile && helper.policy === 'required') {
      throw new Error(`desktop bundle requires ${relative}`);
    }
    entry.reason = 'notBuilt';
    io.log(`${helper.name} not built — skipping (${helper.fallback})`);
    return entry;
  }
  io.copy(relative);
  entry.status = 'bundled';
  io.log(`staged ${relative}`);
  return entry;
}

/**
 * Stage every helper and assemble the manifest. Throws when a macOS desktop
 * bundle would ship without a required helper its SDK can build.
 *
 * @param {object} io  see stageNativeHelperEntry, plus `profile` (build profile name) and `arch`
 */
export function stageNativeHelpers(io) {
  const helpers = {};
  for (const helper of NATIVE_HELPERS) helpers[helper.name] = stageNativeHelperEntry(helper, io);
  if (
    io.desktopProfile &&
    io.platform === 'darwin' &&
    NATIVE_HELPERS.some(
      (h) =>
        h.policy === 'required' &&
        helpers[h.name].status !== 'bundled' &&
        helpers[h.name].reason !== 'sdkTooOld'
    )
  ) {
    throw new Error('desktop bundle is missing a required native helper');
  }
  return {
    schemaVersion: NATIVE_HELPERS_MANIFEST_SCHEMA_VERSION,
    profile: io.profile,
    platform: `${io.platform}-${io.arch}`,
    macosSdk: io.sdkVersion ?? null,
    helpers,
  };
}
