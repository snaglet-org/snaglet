export const LOCAL_MODEL_REMOVAL_UI_FLAG = 'local_model_removal_ui' as const;
/** Settings → Command line row and its installer pane. */
export const CLI_PANE_UI_FLAG = 'cli_pane_ui' as const;
/** Providers → the primary/fallback rotation controls on each provider key. */
export const FALLBACK_CREDENTIALS_FLAG = 'fallback_credentials' as const;
/** The Home pane (pinned items, recents, name, agent instructions) as the default pane. */
export const HUB_HOME_FLAG = 'hub_home' as const;

/** Flags intentionally exposed to the desktop frontend. */
export const FRONTEND_FEATURE_FLAG_NAMES = [
  LOCAL_MODEL_REMOVAL_UI_FLAG,
  CLI_PANE_UI_FLAG,
  FALLBACK_CREDENTIALS_FLAG,
  HUB_HOME_FLAG,
] as const;

export type FrontendFeatureFlagName = (typeof FRONTEND_FEATURE_FLAG_NAMES)[number];

export type FrontendFeatureFlags = Record<FrontendFeatureFlagName, boolean>;
