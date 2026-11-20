import { SNAGLET_HOME } from '@server/services/snagletHome';
import { logger } from '@server/config/logger';
import {
  browserApprovalRequired,
  cursorApprovalService,
} from '@server/services/CursorApprovalService';
import { BrowserController } from './BrowserController';
import { PlaywrightDriver } from './playwrightDriver';
import { getWorkspacePalette, getWorkspaceThemeColors } from './workspaceTheme';

export * from './BrowserController';
export * from './profiles';
export type * from './types';

let instance: BrowserController | null = null;

/** Emotion for the agent's in-page flower; a no-op until a controller exists. */
export function setBrowserEmotion(agentId: string, emotion: string, ttlMs: number): void {
  void instance?.setEmotion(agentId, emotion, ttlMs);
}

export function getBrowserController(): BrowserController {
  instance ??= new BrowserController({
    driver: new PlaywrightDriver(),
    home: () => SNAGLET_HOME,
    now: Date.now,
    theme: getWorkspaceThemeColors,
    palette: getWorkspacePalette,
    env: () => process.env,
    log: (line) => logger.info('[browser] op', line),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    startSweeper: (fn) => {
      const t = setInterval(fn, 30_000);
      t.unref?.();
    },
    approval: {
      required: browserApprovalRequired,
      hasGrant: (agentId, profile) => cursorApprovalService.hasSessionGrant(agentId, profile),
      handoff: (i) =>
        cursorApprovalService.requestApproval({
          agentId: i.agentId,
          name: i.name,
          reason: i.message,
          flower: i.flower as never,
          color: i.color,
          kind: 'handoff',
          timeoutMs: i.timeoutMs,
        }),
      request: (i) =>
        cursorApprovalService.requestApproval({
          agentId: i.agentId,
          name: i.name,
          reason: i.reason,
          flower: i.flower as never,
          color: i.color,
          kind: 'browser',
          profile: i.profile,
        }),
    },
  });
  return instance;
}
