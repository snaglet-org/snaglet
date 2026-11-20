import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import {
  DEFAULT_DEV_SERVER_PORT,
  DEFAULT_DEV_CLIENT_PORT,
  DEFAULT_PREVIEW_SERVER_PORT,
  DEFAULT_PREVIEW_CLIENT_PORT,
} from '../../scripts/lib/dev-ports.mjs';
import { resolveBuildProfile, viteSourcemapOption } from '../../build/profiles';
import { quietProxyDuringBoot } from './src/config/quietProxyDuringBoot';
import { firstPaintTheme } from './src/config/firstPaintTheme';

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '../..');

export default defineConfig(({ command, mode, isPreview }) => {
  const hermeticBrowserPreview =
    command === 'build' && process.env.SNAGLET_BUILD_PROFILE === 'browser-preview';
  const env = hermeticBrowserPreview
    ? {
        VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? '/api',
        VITE_APP_NAME: process.env.VITE_APP_NAME ?? 'Snaglet',
      }
    : {
        ...loadEnv(mode, repoRoot, ''),
        ...loadEnv(mode, process.cwd(), ''),
      };

  // Dev-port defaults (scripts/lib/dev-ports.mjs), overridable per checkout so
  // a second worktree can run alongside. CLIENT_PORT is the Vite UI port for
  // both the browser and the Tauri shell's devUrl. The server port (PORT) is
  // never hit by the browser: it calls the relative `/api`, which the proxy
  // below forwards.
  const defaultClientPort = isPreview ? DEFAULT_PREVIEW_CLIENT_PORT : DEFAULT_DEV_CLIENT_PORT;
  const defaultServerPort = isPreview ? DEFAULT_PREVIEW_SERVER_PORT : DEFAULT_DEV_SERVER_PORT;
  const port = env.CLIENT_PORT ? parseInt(env.CLIENT_PORT, 10) : defaultClientPort;
  const serverPort = env.PORT ? parseInt(env.PORT, 10) : defaultServerPort;
  const proxyTarget = `http://localhost:${serverPort}`;
  // Both development and production preview use the client as the single
  // browser origin, including WebSocket upgrades.
  const proxy = {
    '/api': {
      target: proxyTarget,
      changeOrigin: true,
      configure: quietProxyDuringBoot('/api'),
    },
    '/ws': {
      target: proxyTarget,
      ws: true,
      changeOrigin: true,
      configure: quietProxyDuringBoot('/ws'),
    },
  };
  const configPhase = isPreview ? 'preview' : command === 'build' ? 'build' : 'dev';
  console.log(`[vite.config] ${configPhase} ports: client=${port} api-proxy=${proxyTarget}`);
  // A profile build (the build orchestrator sets SNAGLET_BUILD_PROFILE) follows the
  // profile's source-map policy; a bare `vite build` keeps full maps.
  const buildProfile = command === 'build' ? process.env.SNAGLET_BUILD_PROFILE : undefined;
  const sourcemap = buildProfile
    ? viteSourcemapOption(resolveBuildProfile(buildProfile).sourceMaps)
    : true;

  return {
    // The built E2E artifact must not absorb developer-local feature flags or
    // provider settings from ignored .env files. Its controller injects the
    // complete fixed VITE_* allowlist through process.env instead.
    envDir: hermeticBrowserPreview ? false : undefined,
    plugins: [
      codeInspectorPlugin({ bundler: 'vite', needEnvInspector: true }),
      react(),
      tsconfigPaths(),
      // The default theme's canvas in index.html, so no window opens white.
      firstPaintTheme(),
    ],
    // The browser config (src/config.ts) requires VITE_API_BASE_URL +
    // VITE_APP_NAME at runtime. In dev inject the relative base `/api` so the
    // browser hits the Vite origin and the proxy below forwards to the server.
    // An explicit VITE_API_BASE_URL wins.
    define: {
      ...(env.VITE_API_BASE_URL
        ? {}
        : { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') }),
      ...(env.VITE_APP_NAME ? {} : { 'import.meta.env.VITE_APP_NAME': JSON.stringify('Snaglet') }),
    },
    // Treat linked workspace packages as source so HMR picks up edits
    // (don't pre-bundle into node_modules-style optimized deps).
    optimizeDeps: {
      exclude: ['@snaglet/shared', '@snaglet/db', '@snaglet/theme'],
    },
    css: {
      devSourcemap: true,
      preprocessorOptions: {
        scss: {
          api: 'modern',
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap,
    },
    server: {
      port,
      strictPort: true,
      hmr: {
        overlay: true,
      },
      proxy,
    },
    preview: {
      port,
      strictPort: true,
      proxy,
    },
  };
});
