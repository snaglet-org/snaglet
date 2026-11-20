import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

// Standalone test config — deliberately not vite.config.ts, whose dev-server
// concerns (port/proxy resolution, code-inspector, env defines) don't belong
// in a test run. tsconfigPaths supplies the @desktop/* and @snaglet/shared aliases.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
