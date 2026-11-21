import type { BuildProfile } from './schema';

export const desktopProduction = {
  name: 'desktop-production',
  productName: 'Snaglet',
  applicationId: 'com.snaglet.app',
  storageNamespace: 'snaglet-desktop',
  serverPort: 4000,
  clientPort: 3000,
  // In-place updates from the GitHub release's latest.json, signed with the
  // updater key whose public half is in tauri.conf.json.
  updateChannel: 'stable',
  updatesEnabled: true,
  diagnostics: 'production',
  minimumMacOSVersion: '14.0',
  sourceMaps: 'none',
  signing: 'required',
  outputDirectory: 'dist/desktop-production',
} satisfies BuildProfile;
