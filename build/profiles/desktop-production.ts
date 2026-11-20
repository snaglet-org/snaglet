import type { BuildProfile } from './schema';

export const desktopProduction = {
  name: 'desktop-production',
  productName: 'Snaglet',
  applicationId: 'com.snaglet.app',
  storageNamespace: 'snaglet-desktop',
  serverPort: 4000,
  clientPort: 3000,
  // The updater plugin and signed updater artifacts are not shipped yet.
  // Keep release metadata honest until that complete path exists.
  updateChannel: 'disabled',
  updatesEnabled: false,
  diagnostics: 'production',
  minimumMacOSVersion: '14.0',
  sourceMaps: 'none',
  signing: 'required',
  outputDirectory: 'dist/desktop-production',
} satisfies BuildProfile;
