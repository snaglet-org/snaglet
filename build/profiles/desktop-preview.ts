import type { BuildProfile } from './schema';

export const desktopPreview = {
  name: 'desktop-preview',
  productName: 'Snaglet Preview',
  applicationId: 'com.snaglet.app.preview',
  storageNamespace: 'snaglet-desktop-preview',
  serverPort: 4200,
  clientPort: 3200,
  updateChannel: 'disabled',
  updatesEnabled: false,
  diagnostics: 'preview',
  minimumMacOSVersion: '14.0',
  sourceMaps: 'hidden',
  signing: 'not-required',
  outputDirectory: 'dist/desktop-preview',
} satisfies BuildProfile;
