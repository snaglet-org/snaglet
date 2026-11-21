/**
 * UpdateCheckService — daily check for a newer GitHub Release (non-draft,
 * non-prerelease, compared semver-style against `SNAGLET_APP_VERSION` or the npm
 * package version), surfaced as an `app_update` notification. Ticked hourly so
 * a sleeping laptop catches up; the watermark and last-notified version persist
 * in `settings`. A manual check (POST /api/server/update-check, Settings →
 * Updates) skips the cadence but not the per-version dedupe, and runs at most
 * once a minute. The request is unauthenticated and never carries a stored
 * credential. Failures log at debug; the last one's reason is kept in memory
 * for the status, and a failed check does not count as the day's check.
 *
 * Only a build that can install updates (the desktop shell sets
 * SNAGLET_UPDATE_NOTICES=1 for the released app) posts the notice; others
 * still check, for Settings → Updates.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { SNAGLET_REPOSITORY, appUpdateOfferTitle } from '@snaglet/shared/constants';
import { appUpdateOfferVersion, compareVersions } from '@snaglet/shared/constants/release';
import { logger } from '@server/config/logger';
import { notificationService } from '@server/services/NotificationService';
import { Settings } from '@snaglet/db/tables/settings';

const LOG_PREFIX = '[update-check]';

/** GitHub repo to check, overridable for forks. */
const REPO = process.env.SNAGLET_UPDATE_REPO?.trim() || SNAGLET_REPOSITORY;

/** One real check per day. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Tick hourly so sleep/wake gaps self-heal within an hour. */
const TICK_MS = 60 * 60 * 1000;

/** Don't compete with server boot. */
const INITIAL_DELAY_MS = 90_000;

/** GitHub answers a rate-limited request with 403 or 429. */
const RATE_LIMITED_STATUSES = new Set([403, 429]);

/**
 * Least time between checks a person asks for. GitHub allows an address 60
 * unauthenticated API requests an hour, so repeated clicks reuse the result.
 */
const USER_CHECK_SPACING_MS = 60_000;

/** settings-table coordinates for persisted check state. The category must
 * match the settings table's lowercase_underscore format constraint. */
const STATE_CATEGORY = 'update_check';
const STATE_KEY = 'state';

interface UpdateCheckState {
  lastCheckedAt: string | null;
  lastNotifiedVersion: string | null;
  /** Latest known release, kept for the status endpoint / UI. */
  latest: LatestRelease | null;
}

interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string | null;
  name: string | null;
}

interface UpdateStatus {
  currentVersion: string;
  lastCheckedAt: string | null;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  /** Why the most recent check failed, or null when it succeeded or none ran yet. */
  lastError: string | null;
}

/** Whether this server may post "update available" notices. */
function updateNoticesEnabled(): boolean {
  return process.env.SNAGLET_UPDATE_NOTICES === '1';
}

function appVersion(): string {
  return (
    process.env.SNAGLET_APP_VERSION?.trim() || process.env.npm_package_version?.trim() || '0.1.0'
  );
}

class UpdateCheckServiceClass {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private lastError: string | null = null;
  private lastUserCheckAt = 0;

  start(): void {
    if (this.timer) return;
    this.initialTimer = setTimeout(() => {
      void this.tick();
    }, INITIAL_DELAY_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    logger.info(`${LOG_PREFIX} started (repo ${REPO}, daily cadence, hourly tick)`);
    void this.dismissSettledOffers();
  }

  /**
   * Dismiss "update available" notices for a release this app already runs,
   * which is what is left behind after an update installs.
   */
  async dismissSettledOffers(): Promise<number> {
    const current = appVersion();
    let dismissed = 0;
    try {
      for (const notice of await notificationService.listVisibleOfType('app_update')) {
        const offered = appUpdateOfferVersion(notice);
        if (offered === null || compareVersions(offered, current) > 0) continue;
        await notificationService.dismiss(notice.id);
        dismissed += 1;
      }
    } catch (error: unknown) {
      logger.warn(
        `${LOG_PREFIX} could not clear settled update notices: ${getErrorMessage(error)}`
      );
    }
    return dismissed;
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /** Status snapshot for the UI (no network). */
  async status(): Promise<UpdateStatus> {
    const state = await this.readState();
    const current = appVersion();
    const latest = state.latest;
    return {
      currentVersion: current,
      lastCheckedAt: state.lastCheckedAt,
      latest,
      updateAvailable: latest !== null && compareVersions(latest.version, current) > 0,
      lastError: this.lastError,
    };
  }

  /**
   * A check a person asked for (Settings → Updates, the REST route). Within a
   * minute of the previous one it returns that result instead of asking
   * GitHub again.
   */
  async checkFromUser(): Promise<UpdateStatus> {
    if (Date.now() - this.lastUserCheckAt < USER_CHECK_SPACING_MS) return this.status();
    this.lastUserCheckAt = Date.now();
    return this.checkNow();
  }

  /** Cadence-gated tick. */
  private async tick(): Promise<void> {
    const state = await this.readState();
    if (state.lastCheckedAt) {
      const elapsed = Date.now() - Date.parse(state.lastCheckedAt);
      if (Number.isFinite(elapsed) && elapsed < UPDATE_CHECK_INTERVAL_MS) return;
    }
    await this.checkNow();
  }

  /**
   * Perform one real check. Manual entry point for the REST route — bypasses
   * the daily cadence, keeps per-version notification dedupe.
   */
  async checkNow(): Promise<UpdateStatus> {
    if (this.checking) return this.status();
    this.checking = true;
    try {
      const state = await this.readState();
      const release = await this.fetchLatestRelease();
      // A check that did not reach an answer leaves lastCheckedAt alone, so the
      // next hourly tick retries instead of waiting a full day.
      if (release === 'failed') return this.status();
      const now = new Date().toISOString();

      if (release === null) {
        // No release published yet.
        await this.writeState({ ...state, lastCheckedAt: now });
        return this.status();
      }

      const current = appVersion();
      const newer = compareVersions(release.version, current) > 0;
      const nextState: UpdateCheckState = {
        lastCheckedAt: now,
        lastNotifiedVersion: state.lastNotifiedVersion,
        latest: release,
      };

      if (newer && updateNoticesEnabled() && state.lastNotifiedVersion !== release.version) {
        await notificationService.create({
          type: 'app_update',
          title: appUpdateOfferTitle(release.version),
          body: `You are on ${current}. Click to update.`,
        });
        nextState.lastNotifiedVersion = release.version;
        logger.info(`${LOG_PREFIX} update available: ${current} → ${release.version} (notified)`);
      }

      await this.writeState(nextState);
      return this.status();
    } finally {
      this.checking = false;
    }
  }

  /** The latest release, null when none is published, or 'failed' (reason in lastError). */
  private async fetchLatestRelease(): Promise<LatestRelease | null | 'failed'> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Snaglet',
    };
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers,
      });
      if (res.status === 404) {
        // No release published yet, a normal state: stay quiet.
        logger.debug(`${LOG_PREFIX} no release found (404) for ${REPO}`);
        this.lastError = null;
        return null;
      }
      if (RATE_LIMITED_STATUSES.has(res.status)) {
        logger.debug(`${LOG_PREFIX} GitHub API ${res.status} for ${REPO}; retrying next tick`);
        this.lastError = 'GitHub is limiting requests right now. Try again later.';
        return 'failed';
      }
      if (!res.ok) {
        logger.debug(`${LOG_PREFIX} GitHub API ${res.status} for ${REPO}`);
        this.lastError = `GitHub answered with status ${res.status}.`;
        return 'failed';
      }
      this.lastError = null;
      const body = (await res.json()) as {
        tag_name?: string;
        name?: string | null;
        html_url?: string;
        published_at?: string | null;
        draft?: boolean;
        prerelease?: boolean;
      };
      if (!body.tag_name || body.draft || body.prerelease) return null;
      return {
        version: body.tag_name,
        url: body.html_url ?? `https://github.com/${REPO}/releases/latest`,
        publishedAt: body.published_at ?? null,
        name: body.name ?? null,
      };
    } catch (err) {
      // Network down is an everyday laptop condition, not an error.
      logger.debug(`${LOG_PREFIX} fetch failed: ${getErrorMessage(err)}`);
      this.lastError = 'Snaglet couldn’t reach GitHub.';
      return 'failed';
    }
  }

  private async readState(): Promise<UpdateCheckState> {
    try {
      const row = await Settings.read(STATE_CATEGORY, STATE_KEY);
      const raw = row?.value;
      if (raw && typeof raw === 'object') {
        const s = raw as Partial<UpdateCheckState>;
        return {
          lastCheckedAt: typeof s.lastCheckedAt === 'string' ? s.lastCheckedAt : null,
          lastNotifiedVersion:
            typeof s.lastNotifiedVersion === 'string' ? s.lastNotifiedVersion : null,
          latest:
            s.latest && typeof s.latest === 'object' && typeof s.latest.version === 'string'
              ? (s.latest as LatestRelease)
              : null,
        };
      }
    } catch (err) {
      logger.debug(`${LOG_PREFIX} state read failed: ${getErrorMessage(err)}`);
    }
    return { lastCheckedAt: null, lastNotifiedVersion: null, latest: null };
  }

  private async writeState(state: UpdateCheckState): Promise<void> {
    try {
      await Settings.write(STATE_CATEGORY, STATE_KEY, state);
    } catch (err) {
      logger.warn(`${LOG_PREFIX} state write failed: ${getErrorMessage(err)}`);
    }
  }
}

export const updateCheckService = new UpdateCheckServiceClass();
