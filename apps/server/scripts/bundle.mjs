/**
 * Server bundle build: a self-contained artifact at <repo>/dist/bundle/ with
 * server.mjs (one esbuild ESM bundle), migrations/ (found via dbDirname) and
 * builtin-skills/ (found beside server.mjs). Steps: generate the static tool
 * registry, esbuild with the registry source aliased to it, copy assets, and
 * fail if the JS exceeds the 20 MB budget.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { stageNativeHelpers } from './lib/nativeHelpers.mjs';
import { stageFsevents } from './lib/stageFsevents.mjs';

const requireFromHere = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'bundle');
const JS_BUDGET_BYTES = 20 * 1024 * 1024;

function log(msg) {
  console.log(`[bundle] ${msg}`);
}

log('generating static tool registry…');
// node + resolved tsx CLI, not `npx` — spawning npx is ENOENT on Windows
// (npx is npx.cmd there) and slower everywhere.
execFileSync(
  process.execPath,
  [
    requireFromHere.resolve('tsx/cli'),
    'src/services/ToolService/scripts/generate-tool-registry.ts',
  ],
  { cwd: SERVER_DIR, stdio: 'inherit' }
);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/** Swap the dynamic registry-source for the codegen'd static module. */
const staticRegistryPlugin = {
  name: 'static-tool-registry',
  setup(build) {
    build.onResolve({ filter: /^\.\/registry-source$/ }, (args) => {
      if (!args.importer.endsWith(path.join('ToolService', 'ToolRegistry.ts'))) {
        return null; // type-only imports elsewhere resolve normally
      }
      return {
        path: path.join(SERVER_DIR, 'src/services/ToolService/generated/registry-source.static.ts'),
      };
    });
  },
};

/**
 * Swap `googleapis` for the slim shim — the real package index statically
 * requires ~330 API clients (≈34MB bundled); Snaglet uses six. Value-level
 * importers get the shim; type-only imports are erased before resolution.
 */
const googleapisSlimPlugin = {
  name: 'googleapis-slim',
  setup(build) {
    build.onResolve({ filter: /^googleapis$/ }, (args) => {
      if (args.importer.includes('googleapis-slim')) return null;
      return { path: path.join(SERVER_DIR, 'src/shims/googleapis-slim.ts') };
    });
  },
};

log('bundling server.mjs…');
const result = await esbuild.build({
  entryPoints: [path.join(SERVER_DIR, 'src/index.ts')],
  outfile: path.join(OUT_DIR, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
  tsconfig: path.join(SERVER_DIR, 'tsconfig.json'),
  // Kept external and staged below: fsevents, onnxruntime and sharp are native
  // (macOS builds fail without fsevents; elsewhere chokidar uses fs.watch).
  // esbuild must stay a real CommonJS package: bundled, its __dirname and
  // worker paths point at the wrong module. playwright-core requires the
  // optional chromium-bidi peer, which is not installed and cannot resolve.
  external: [
    'pg-native',
    'fsevents',
    'esbuild',
    'onnxruntime-node',
    'onnxruntime-common',
    'sharp',
    'playwright-core',
  ],
  plugins: [staticRegistryPlugin, googleapisSlimPlugin],
  define: {
    // Disarms isMainModule()-style CLI guards in inlined modules (db.ts,
    // migrations.ts) — inside the bundle their module URL IS argv[1].
    'process.env.SNAGLET_BUNDLED': "'1'",
  },
  banner: {
    // CJS-interop shim: bundled CJS deps call require() at runtime. No
    // __filename/__dirname here — app entry modules declare their own and
    // a banner declaration would collide in the flattened module scope.
    js: [
      `import { createRequire as __bundleCreateRequire } from 'node:module';`,
      `const require = __bundleCreateRequire(import.meta.url);`,
    ].join('\n'),
  },
});

writeFileSync(path.join(OUT_DIR, 'metafile.json'), JSON.stringify(result.metafile));

log('bundling voice-engine worker graph…');
// The voice worker is spawned by path and dynamic-imports voiceEngine by URL,
// both resolved beside the caller's module, so esbuild never sees them. Each is
// emitted as its own flat file directly under OUT_DIR. Bundled, the caller's
// import.meta.url is server.mjs, so its `.ts` check takes the compiled `.js`
// branch with dir = OUT_DIR. Native addons stay external and are copied below.
const WORKER_ENTRY_EXTERNAL = ['onnxruntime-node', 'onnxruntime-common', 'sherpa-onnx-node'];
const WORKER_ENTRIES = [
  ['src/services/voice/voiceEngineWorker.ts', 'voiceEngineWorker.js'],
  ['src/services/voice/voiceEngine.ts', 'voiceEngine.js'],
];
for (const [entry, outName] of WORKER_ENTRIES) {
  await esbuild.build({
    entryPoints: [path.join(SERVER_DIR, entry)],
    outfile: path.join(OUT_DIR, outName),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    logLevel: 'warning',
    tsconfig: path.join(SERVER_DIR, 'tsconfig.json'),
    external: WORKER_ENTRY_EXTERNAL,
    banner: {
      js: [
        `import { createRequire as __bundleCreateRequire } from 'node:module';`,
        `const require = __bundleCreateRequire(import.meta.url);`,
      ].join('\n'),
    },
  });
}

log('copying db bootstrap assets…');
cpSync(path.join(REPO_ROOT, 'packages/db/migrations'), path.join(OUT_DIR, 'migrations'), {
  recursive: true,
});

log('copying built-in skills…');
cpSync(path.join(SERVER_DIR, 'builtin-skills'), path.join(OUT_DIR, 'builtin-skills'), {
  recursive: true,
});

log('copying pruned esbuild runtime…');
const ESBUILD_SRC = path.dirname(requireFromHere.resolve('esbuild/package.json'));
const ESBUILD_OUT = path.join(OUT_DIR, 'node_modules/esbuild');
mkdirSync(path.join(ESBUILD_OUT, 'lib'), { recursive: true });
cpSync(path.join(ESBUILD_SRC, 'package.json'), path.join(ESBUILD_OUT, 'package.json'));
cpSync(path.join(ESBUILD_SRC, 'lib/main.js'), path.join(ESBUILD_OUT, 'lib/main.js'));

// esbuild's JS API resolves a platform-specific native executable from one of
// its optional @esbuild/* dependencies. Package managers install only the
// build host's matching package, so stage whichever optional dependency is
// actually resolvable instead of hard-coding a platform-name matrix here.
const esbuildPackage = JSON.parse(readFileSync(path.join(ESBUILD_SRC, 'package.json'), 'utf8'));
const stagedEsbuildPlatforms = [];
for (const packageName of Object.keys(esbuildPackage.optionalDependencies ?? {})) {
  let packageJson;
  try {
    packageJson = requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    continue;
  }
  const source = path.dirname(packageJson);
  const packageMetadata = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (
    !packageMetadata.os?.includes(process.platform) ||
    !packageMetadata.cpu?.includes(process.arch)
  ) {
    continue;
  }
  const output = path.join(OUT_DIR, 'node_modules', ...packageName.split('/'));
  mkdirSync(output, { recursive: true });
  cpSync(packageJson, path.join(output, 'package.json'));
  const executable = process.platform === 'win32' ? 'esbuild.exe' : 'bin';
  cpSync(path.join(source, executable), path.join(output, executable), { recursive: true });
  stagedEsbuildPlatforms.push(packageName);
}
if (stagedEsbuildPlatforms.length !== 1) {
  throw new Error(
    `server bundle requires exactly one installed @esbuild package for ${process.platform}/${process.arch}; found ${stagedEsbuildPlatforms.length}`
  );
}
log(`staged esbuild platform package(s): ${stagedEsbuildPlatforms.join(', ')}`);

log('copying pruned onnxruntime-node…');
const ORT_SRC = path.join(REPO_ROOT, 'node_modules/onnxruntime-node');
const ORT_OUT = path.join(OUT_DIR, 'node_modules/onnxruntime-node');
const ORT_COMMON_SRC = path.join(REPO_ROOT, 'node_modules/onnxruntime-common');
const ORT_COMMON_OUT = path.join(OUT_DIR, 'node_modules/onnxruntime-common');
mkdirSync(path.join(ORT_OUT, 'bin/napi-v6', process.platform), { recursive: true });
cpSync(path.join(ORT_SRC, 'package.json'), path.join(ORT_OUT, 'package.json'));
cpSync(path.join(ORT_SRC, 'dist'), path.join(ORT_OUT, 'dist'), { recursive: true });
cpSync(
  path.join(ORT_SRC, 'bin/napi-v6', process.platform, process.arch),
  path.join(ORT_OUT, 'bin/napi-v6', process.platform, process.arch),
  { recursive: true }
);
mkdirSync(ORT_COMMON_OUT, { recursive: true });
cpSync(path.join(ORT_COMMON_SRC, 'package.json'), path.join(ORT_COMMON_OUT, 'package.json'));
cpSync(path.join(ORT_COMMON_SRC, 'dist'), path.join(ORT_COMMON_OUT, 'dist'), { recursive: true });

log('copying sherpa-onnx-node…');
// sherpa-onnx-node itself is pure JS (no native code) — copy it whole.
cpSync(
  path.join(REPO_ROOT, 'node_modules/sherpa-onnx-node'),
  path.join(OUT_DIR, 'node_modules/sherpa-onnx-node'),
  { recursive: true, dereference: true }
);
// The native addon ships in a per-platform package (sherpa-onnx-<platform>-<arch>,
// "win" rather than "win32"), which addon.js requires one directory up, so it
// must sit beside node_modules/sherpa-onnx-node. Only the build machine's own
// platform is installed; packaging another target means building on it.
const SHERPA_PLATFORM = process.platform === 'win32' ? 'win' : process.platform;
const SHERPA_PLATFORM_PKG = `sherpa-onnx-${SHERPA_PLATFORM}-${process.arch}`;
log(`copying ${SHERPA_PLATFORM_PKG} (native addon)…`);
cpSync(
  path.join(REPO_ROOT, 'node_modules', SHERPA_PLATFORM_PKG),
  path.join(OUT_DIR, 'node_modules', SHERPA_PLATFORM_PKG),
  { recursive: true, dereference: true }
);

/**
 * Locate an installed package's directory (real path, not pnpm's symlink) from
 * a resolver. `<name>/package.json` is the cheap path; packages with a strict
 * `exports` map (sharp, @img/sharp-*) refuse it, so try the `package` subpath
 * next and finally resolve the entry point and walk up to the package root.
 */
function locatePackageDir(packageName, resolver) {
  // `<name>/package.json` for ordinary packages; `<name>/package` is the
  // subpath the @img/sharp-* platform packages export it under.
  for (const subpath of ['package.json', 'package']) {
    try {
      return realpathSync(path.dirname(resolver.resolve(`${packageName}/${subpath}`)));
    } catch {
      // try the next form
    }
  }
  let entry;
  try {
    entry = resolver.resolve(packageName);
  } catch {
    return null;
  }
  let dir = path.dirname(entry);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      const metadata = JSON.parse(readFileSync(candidate, 'utf8'));
      // Real path, not pnpm's symlink: dependencies of this package are
      // resolved from its store location, where its own node_modules lives.
      if (metadata.name === packageName) return realpathSync(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True unless the package declares an os/cpu list that excludes this host. */
function matchesHostPlatform(metadata) {
  const osOk = !Array.isArray(metadata.os) || metadata.os.includes(process.platform);
  const cpuOk = !Array.isArray(metadata.cpu) || metadata.cpu.includes(process.arch);
  return osOk && cpuOk;
}

/**
 * Stage an external runtime package and its dependency closure under
 * OUT_DIR/node_modules as a plain (dereferenced) tree. Regular `dependencies`
 * are followed recursively; `optionalDependencies` are staged only when they
 * are installed AND built for this host's platform/arch — the same
 * single-platform rule the esbuild/onnxruntime/sherpa steps above apply.
 * Returns the set of staged package names.
 */
function stagePackageTree(packageName, resolver = requireFromHere, staged = new Set()) {
  if (staged.has(packageName)) return staged;
  const source = locatePackageDir(packageName, resolver);
  if (!source) return staged;
  const metadata = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!matchesHostPlatform(metadata)) return staged;

  staged.add(packageName);
  cpSync(source, path.join(OUT_DIR, 'node_modules', ...packageName.split('/')), {
    recursive: true,
    dereference: true,
  });

  const fromHere = createRequire(path.join(source, 'package.json'));
  for (const dep of Object.keys(metadata.dependencies ?? {})) {
    stagePackageTree(dep, fromHere, staged);
  }
  for (const dep of Object.keys(metadata.optionalDependencies ?? {})) {
    stagePackageTree(dep, fromHere, staged);
  }
  return staged;
}

log('staging sharp (image rasterizer, native addon)…');
const stagedSharp = stagePackageTree('sharp');
if (
  !stagedSharp.has('sharp') ||
  ![...stagedSharp].some((name) => /^@img\/sharp-(?!libvips)/.test(name))
) {
  throw new Error(
    `server bundle requires sharp plus an installed @img/sharp-* package for ${process.platform}/${process.arch}; staged: ${[...stagedSharp].join(', ') || 'none'}`
  );
}
log(`staged sharp closure: ${[...stagedSharp].join(', ')}`);

// playwright-core (browser tool): imported with `await import('playwright-core')`
// at the first browser call, so it resolves from OUT_DIR/node_modules at runtime.
log('staging playwright-core (browser tool)…');
const stagedPlaywright = stagePackageTree('playwright-core');
if (!stagedPlaywright.has('playwright-core')) {
  throw new Error('server bundle requires playwright-core to be staged; it was not found');
}
log(`staged playwright-core closure: ${[...stagedPlaywright].join(', ')}`);

// fsevents (macOS only): without it chokidar falls back to a stat-polling
// watch mode (~45% idle CPU in Snaglet.app). See lib/stageFsevents.mjs; the packaged
// app is re-checked by build/scripts/native-helpers.ts assertPackagedFsevents.
stageFsevents({ stagePackageTree, log });

// Native macOS helpers (darwin only): built and staged per the policy table in
// lib/nativeHelpers.mjs (required: apple-stt, apple-tts, nlp-helper;
// best-effort: apple-chat). A desktop profile always BUILDS each helper from a
// clean worktree, except one whose APIs the SDK lacks (apple-stt before the
// macOS 26 SDK), and records exactly what it shipped and the SDK in
// native/helpers.json, which verify-desktop-production.ts re-checks inside the
// packaged app. API-only bundles stage whatever is already built, never
// compile, and still record the outcome.
const DESKTOP_PROFILE = process.env.SNAGLET_BUILD_PROFILE?.startsWith('desktop-') === true;

/**
 * The macOS SDK the helper build scripts compile against (native/macos-sdk.sh
 * picks it the same way), or null when it cannot be read, in which case every
 * helper is built and a required one that fails still fails the bundle.
 */
function helperSdkVersion() {
  if (process.platform !== 'darwin' || !DESKTOP_PROFILE) return null;
  try {
    const version = execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; snaglet_macos_sdk_version',
        '--',
        path.join(SERVER_DIR, 'native/macos-sdk.sh'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    ).trim();
    if (version) log(`native helpers build with the macOS ${version} SDK`);
    return version || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`could not read the macOS SDK version (${message}); building every helper`);
    return null;
  }
}

const helpersManifest = stageNativeHelpers({
  platform: process.platform,
  arch: process.arch,
  profile: process.env.SNAGLET_BUILD_PROFILE ?? 'api',
  desktopProfile: DESKTOP_PROFILE,
  sdkVersion: helperSdkVersion(),
  build: (helper) => {
    const script = path.join(SERVER_DIR, `native/${helper.name}/build.sh`);
    execFileSync('bash', [script], { cwd: SERVER_DIR, stdio: 'inherit' });
  },
  exists: (relative) =>
    statSync(path.join(SERVER_DIR, relative), { throwIfNoEntry: false })?.isFile() === true,
  copy: (relative) => {
    const output = path.join(OUT_DIR, relative);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(path.join(SERVER_DIR, relative), output);
  },
  log,
});
mkdirSync(path.join(OUT_DIR, 'native'), { recursive: true });
writeFileSync(
  path.join(OUT_DIR, 'native/helpers.json'),
  `${JSON.stringify(helpersManifest, null, 2)}\n`
);
log(
  `native helpers: ${Object.entries(helpersManifest.helpers)
    .map(([name, entry]) => `${name}=${entry.status}${entry.reason ? `(${entry.reason})` : ''}`)
    .join(', ')}`
);

// When apps/desktop-ui/dist exists, stage it at static/web so the bundled
// server serves the SPA. API-only deploys and bundle smoke checks may omit UI
// assets, but a desktop profile must fail closed: packaging an API-only shell
// is never a valid desktop artifact.
const UI_DIST = path.join(REPO_ROOT, 'apps/desktop-ui/dist');
if (statSync(UI_DIST, { throwIfNoEntry: false })?.isDirectory()) {
  log('staging desktop-ui at static/web…');
  cpSync(UI_DIST, path.join(OUT_DIR, 'static/web'), { recursive: true });
} else if (process.env.SNAGLET_BUILD_PROFILE?.startsWith('desktop-')) {
  throw new Error(
    `desktop build requires compiled UI assets at ${UI_DIST}; run the web build before bundling`
  );
} else {
  log('desktop-ui dist not found — skipping UI staging (API-only bundle)');
}

const jsBytes = statSync(path.join(OUT_DIR, 'server.mjs')).size;
const totalBytes = (() => {
  let total = 0;
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(OUT_DIR);
  return total;
})();
log(`server.mjs: ${(jsBytes / 1024 / 1024).toFixed(2)} MB (budget 20 MB)`);
log(`dist/bundle total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
if (jsBytes > JS_BUDGET_BYTES) {
  console.error(`[bundle] FAIL: server.mjs exceeds the 20MB JS budget`);
  process.exit(1);
}
log('done.');
