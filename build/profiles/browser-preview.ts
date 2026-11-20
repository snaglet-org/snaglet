import type { BuildProfile } from './schema';

export const browserPreview = {
  name: 'browser-preview',
  productName: 'Snaglet Browser Preview',
  applicationId: 'com.snaglet.browser.preview',
  storageNamespace: 'snaglet-browser-preview',
  serverPort: 4100,
  clientPort: 3100,
  updateChannel: 'disabled',
  updatesEnabled: false,
  diagnostics: 'preview',
  minimumMacOSVersion: null,
  sourceMaps: 'public',
  signing: 'not-required',
  outputDirectory: 'dist/browser-preview',
} satisfies BuildProfile;
