import type { ToolHandler } from '@server/services/ToolService/types';
import {
  clampSidebarScrollDuration,
  parseSidebarTarget,
  resolveSidebarTabId,
} from '@snaglet/shared/types';
import { requestSidebar, resolveAnyConnectedUserId } from '@server/realtime/surfaces/ui';

const tool: ToolHandler = async (input, _settings, context) => {
  const { op, tab, target, width_px, to, duration_ms } = input;
  if (
    op !== 'open' &&
    op !== 'close' &&
    op !== 'status' &&
    op !== 'inspect' &&
    op !== 'expand' &&
    op !== 'collapse' &&
    op !== 'resize' &&
    op !== 'scroll'
  ) {
    throw new Error(
      'op is required and must be one of open | close | status | inspect | expand | collapse | resize | scroll.'
    );
  }
  const allowed = ['op', 'tab', 'target', 'width_px', 'to', 'duration_ms'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error(
      'sidebar accepts only op, tab, target, width_px, to and duration_ms. Nothing was changed.'
    );
  }
  // An alias tab id opens the view it maps to (`hooks` → Automations).
  const openTab = tab === undefined ? null : resolveSidebarTabId(tab);
  if (tab !== undefined && (op !== 'open' || !openTab)) {
    throw new Error(
      'tab must be a sidebar activity-bar ID and is accepted only by open. Nothing was changed.'
    );
  }
  if (
    op === 'resize'
      ? typeof width_px !== 'number' || !Number.isFinite(width_px)
      : width_px !== undefined
  ) {
    throw new Error(
      'width_px must be a finite CSS pixel number for resize only. Nothing was changed.'
    );
  }
  const scroll = op === 'scroll';
  if (!scroll && (to !== undefined || duration_ms !== undefined)) {
    throw new Error('to and duration_ms are accepted by scroll only. Nothing was changed.');
  }
  if (scroll) {
    if ((target === undefined) === (to === undefined)) {
      throw new Error('scroll requires exactly one of target or to. Nothing was changed.');
    }
    if (to !== undefined && to !== 'top' && to !== 'bottom') {
      throw new Error("to must be 'top' or 'bottom'. Nothing was changed.");
    }
    if (
      target !== undefined &&
      (typeof target !== 'string' || !target.trim() || !parseSidebarTarget(target))
    ) {
      throw new Error('target must be an opaque handle from inspect. Nothing was changed.');
    }
    if (
      duration_ms !== undefined &&
      (typeof duration_ms !== 'number' || !Number.isFinite(duration_ms))
    ) {
      throw new Error('duration_ms must be a finite number of milliseconds. Nothing was changed.');
    }
  }
  const disclosure = op === 'expand' || op === 'collapse';
  if (
    !scroll &&
    (disclosure ? typeof target !== 'string' || !parseSidebarTarget(target) : target !== undefined)
  ) {
    throw new Error('target is required for expand/collapse only. Nothing was changed.');
  }
  const duration = scroll
    ? clampSidebarScrollDuration(typeof duration_ms === 'number' ? duration_ms : undefined)
    : undefined;
  const userId = resolveAnyConnectedUserId();
  if (!userId) return JSON.stringify({ success: false, reason: 'no_active_client' });
  const result = await requestSidebar({
    userId,
    command: {
      op,
      ...(typeof width_px === 'number' ? { width_px } : {}),
      ...(openTab ? { tab: openTab } : {}),
      ...(typeof target === 'string' ? { target } : {}),
      ...(scroll && (to === 'top' || to === 'bottom') ? { to } : {}),
      ...(duration !== undefined ? { duration_ms: duration } : {}),
    },
    // The client replies only after the animation finishes.
    ...(duration !== undefined ? { timeoutMs: duration + 3000 } : {}),
    actor: {
      actorId: context?.agentId ?? 'unknown',
      actorKind: 'agent',
      actorName: context?.runtime?.agentName,
    },
  });
  return JSON.stringify(result.success ? { success: true, ...result.state } : result);
};
export default tool;
