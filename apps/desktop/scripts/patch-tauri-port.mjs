#!/usr/bin/env node
/**
 * patch-tauri-port.mjs
 *
 * Patches the devUrl in tauri.conf.json to this checkout's Vite dev-server port
 * (CLIENT_PORT from .env / .env.local, else DEFAULT_DEV_CLIENT_PORT) so the
 * Tauri desktop shell loads the running Vite UI. Per worktree the desktop shell
 * and a browser tab share this one port — no separate "desktop app" port.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_DEV_CLIENT_PORT } from '../../../scripts/lib/dev-ports.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Walk up: apps/desktop/scripts -> apps/desktop -> apps -> root
const rootDir = resolve(__dirname, '..', '..', '..');

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      value = value.replace(/\s+#.*$/, '');
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

const env = {
  ...parseEnvFile(resolve(rootDir, '.env')),
  ...parseEnvFile(resolve(rootDir, '.env.local')),
};

// Explicit .env / .env.local wins; otherwise the fixed default client port.
const port = env.CLIENT_PORT ?? DEFAULT_DEV_CLIENT_PORT;

const confPath = resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));

const newUrl = `http://localhost:${port}`;
if (conf.build.devUrl === newUrl) {
  console.log(`[patch-tauri-port] devUrl already correct: ${newUrl}`);
} else {
  conf.build.devUrl = newUrl;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  console.log(`[patch-tauri-port] Patched devUrl -> ${newUrl}`);
}
