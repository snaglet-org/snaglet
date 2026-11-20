#!/usr/bin/env node

import crossSpawn from 'cross-spawn';
import { DEFAULT_PREVIEW_CLIENT_PORT, DEFAULT_PREVIEW_SERVER_PORT } from './lib/dev-ports.mjs';

const env = {
  ...process.env,
  // Preview mode: built code, production NODE_ENV, but isolated data. The
  // SNAGLET_ENV loader (packages/db/runtime/snaglet-env.ts) inside the built server maps
  // this to .env.preview plus mode defaults (~/.snaglet-dev home, snaglet_preview db).
  SNAGLET_ENV: 'preview',
  NODE_ENV: 'production',
  PORT: process.env.PORT ?? String(DEFAULT_PREVIEW_SERVER_PORT),
  CLIENT_PORT: process.env.CLIENT_PORT ?? String(DEFAULT_PREVIEW_CLIENT_PORT),
  API_BASE_URL:
    process.env.API_BASE_URL ??
    `http://localhost:${process.env.PORT ?? DEFAULT_PREVIEW_SERVER_PORT}`,
};

function run(args, options = {}) {
  return crossSpawn('pnpm', args, {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
}

console.log(`Building Snaglet preview (client :${env.CLIENT_PORT}, server :${env.PORT})...`);
const build = run(['run', 'build:browser-preview']);
const buildExitCode = await new Promise((resolve) => build.once('exit', resolve));

if (buildExitCode !== 0) {
  process.exit(buildExitCode ?? 1);
}

const preview = run([
  'exec',
  'concurrently',
  '--kill-others-on-fail',
  '--names',
  'server,client',
  '--prefix-colors',
  'blue,magenta',
  'node dist/browser-preview/app/server.mjs',
  'pnpm --filter @snaglet/desktop-ui preview',
]);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => preview.kill(signal));
}

const previewExitCode = await new Promise((resolve) => preview.once('exit', resolve));
process.exit(previewExitCode ?? 1);
