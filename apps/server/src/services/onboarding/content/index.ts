import { ETC_DOCS } from './etc';
import { FEATURE_DOCS } from './features';
import { REFERENCE_DOCS } from './reference';
import { RESPONSIBLE_AI_DOCS } from './responsibleAi';
import { START_HERE_DOCS } from './startHere';
import type { OnboardingDocSource, OnboardingFolder } from './types';

export { SAMPLE_PROJECT_DOCS } from './sampleProject';

/**
 * The folders in the Onboarding folder, each parent's folders in sidebar
 * order. `parent` is the folder one sits in, listed before it; without one it
 * sits in the Onboarding folder itself.
 */
export const ONBOARDING_FOLDERS: ReadonlyArray<{
  key: OnboardingFolder;
  name: string;
  parent?: OnboardingFolder;
}> = [
  { key: 'start', name: 'Start here' },
  { key: 'features', name: 'Features' },
  { key: 'reference', name: 'Reference' },
  { key: 'responsible-ai', name: 'Using AI Responsibly', parent: 'reference' },
  { key: 'etc', name: 'etc' },
];

/** Every doc in the Onboarding folder, folder by folder, each folder in sidebar order. */
export const ONBOARDING_DOCS: readonly OnboardingDocSource[] = [
  ...START_HERE_DOCS,
  ...FEATURE_DOCS,
  ...REFERENCE_DOCS,
  ...RESPONSIBLE_AI_DOCS,
  ...ETC_DOCS,
];
