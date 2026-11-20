import { FeatureFlags } from '@snaglet/db/tables/feature_flags';
import { FRONTEND_FEATURE_FLAG_NAMES, type FrontendFeatureFlags } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/** Flags only the server reads. They gate server behavior and never reach the UI. */
type ServerFeatureFlagName = 'reranker';

/**
 * How long a server flag value is reused. Hot paths such as search read their
 * flag on every call, so a changed row takes effect within this window.
 */
const SERVER_FLAG_TTL_MS = 30_000;

interface CachedServerFlag {
  enabled: Promise<boolean>;
  expiresAt: number;
}

class FeatureFlagService {
  private readonly serverFlags = new Map<ServerFeatureFlagName, CachedServerFlag>();

  /**
   * Return only the explicit frontend allowlist. A missing seeded row is false,
   * so schema drift cannot accidentally expose a destructive control.
   */
  async getFrontendFlags(): Promise<FrontendFeatureFlags> {
    const rows = await FeatureFlags.listByNames(FRONTEND_FEATURE_FLAG_NAMES);
    const enabledByName = new Map(rows.map((row) => [row.name, row.enabled === true]));
    const flags = {} as FrontendFeatureFlags;
    for (const name of FRONTEND_FEATURE_FLAG_NAMES) {
      const row = enabledByName.get(name);
      flags[name] = row === true;
    }
    return flags;
  }

  /**
   * Whether a server-only flag is on. A missing row or a failed read is off.
   * The value is cached for {@link SERVER_FLAG_TTL_MS}.
   */
  isServerFlagEnabled(name: ServerFeatureFlagName): Promise<boolean> {
    const now = Date.now();
    const cached = this.serverFlags.get(name);
    if (cached && cached.expiresAt > now) return cached.enabled;
    const enabled = FeatureFlags.isEnabled(name).catch((err: unknown) => {
      logger.warn(
        `[feature-flags] could not read "${name}", treating it as off: ${getErrorMessage(err)}`
      );
      return false;
    });
    this.serverFlags.set(name, { enabled, expiresAt: now + SERVER_FLAG_TTL_MS });
    return enabled;
  }

  /** Forget cached server flag values so the next check reads the table. */
  clearServerFlagCache(): void {
    this.serverFlags.clear();
  }
}

export const featureFlagService = new FeatureFlagService();
