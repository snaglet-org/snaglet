import { execFileSync } from 'node:child_process';

export const APP_DEVICE_ENTITLEMENTS = [
  'com.apple.security.device.camera',
  'com.apple.security.device.audio-input',
];

/** Refuse a mislabeled artifact before any archive or publication is created. */
export function assertReleaseVersion(tag, sourceVersion, bundleVersion) {
  if (!tag || tag !== `v${sourceVersion}` || bundleVersion !== sourceVersion) {
    throw new Error(
      `Release version mismatch: tag=${tag}, source=${sourceVersion}, bundle=${bundleVersion}. Rebuild the matching version before publishing.`
    );
  }
}

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Fill each `{{NAME}}` in a release-notes template from `values`. Throws when
 * any placeholder is left, so a typo or a new placeholder never ships as text.
 */
export function renderReleaseNotes(template, values) {
  const rendered = template.replace(PLACEHOLDER, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  );
  const left = [...new Set(rendered.match(PLACEHOLDER) ?? [])];
  if (left.length > 0) {
    throw new Error(`Release notes still contain unfilled placeholders: ${left.join(', ')}`);
  }
  return rendered;
}

/**
 * A published release ships every required native helper. A local build on an
 * SDK older than a helper needs skips it (apps/server/scripts/lib/
 * nativeHelpers.mjs); that build runs, but publishing it would hand users an
 * app without Apple's on-device dictation.
 */
export function assertReleaseNativeHelpers(manifest) {
  const missing = Object.entries(manifest?.helpers ?? {})
    .filter(([, entry]) => entry?.policy === 'required' && entry?.status !== 'bundled')
    .map(([name, entry]) => `${name} (${entry?.reason ?? 'skipped'})`);
  if (missing.length > 0) {
    throw new Error(
      `This build is missing required native helpers: ${missing.join(', ')}. It was built ` +
        `with the macOS ${manifest?.macosSdk ?? 'unknown'} SDK; build releases with the ` +
        'macOS 26 SDK (Xcode or Command Line Tools 26).'
    );
  }
}

export function assertAppEntitlements(entitlements) {
  for (const key of APP_DEVICE_ENTITLEMENTS) {
    if (entitlements?.[key] !== true) {
      throw new Error(`Signed app is missing required entitlement: ${key}`);
    }
  }
}

/** Inspect the final signature, not merely the plist supplied to codesign. */
export function verifyAppEntitlements(app) {
  const xml = execFileSync('codesign', ['-d', '--entitlements', ':-', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: xml,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertAppEntitlements(JSON.parse(json));
}
