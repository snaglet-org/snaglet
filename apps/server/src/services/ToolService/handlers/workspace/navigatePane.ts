/**
 * navigate_user_pane — agent-driven navigation of a user's pane.
 *
 * Takes a flat `target: { kind, id }` and maps it to the camelCase wire format
 * the UI expects (kind-specific id field), then emits the navigation command via
 * the addressed UI transport. Degrades gracefully when no client is connected.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import type {
  PaneNavigationMode,
  PaneNavigationTarget,
  PaneSplitZone,
} from '@snaglet/shared/types';
import { emitNavigatePane, resolveAnyConnectedUserId } from '@server/realtime/surfaces/ui';
import { Nodes } from '@snaglet/db/tables/nodes';

/**
 * Map a target `kind` to the camelCase id field the UI wire format expects.
 * The single `id` the agent passes is placed under this key. `providers` is the
 * only kind whose id is optional (it can open the bare providers list).
 */
const KIND_TO_WIRE: Record<string, string> = {
  doc: 'docId',
  thread: 'threadId',
  container: 'containerId',
  tool: 'toolId',
  image: 'imageId',
  providers: 'providerId',
};

const NAVIGATION_MODES = new Set<PaneNavigationMode>(['split', 'replace']);
const SPLIT_ZONES = new Set<PaneSplitZone>(['right', 'left', 'bottom', 'top']);

const tool: ToolHandler = async (rawInput, _settings, context) => {
  const agentId = context?.agentId ?? 'unknown';
  const agentName = context?.runtime?.agentName;

  const input = rawInput as {
    pane_key?: string;
    mode?: string;
    split_zone?: string;
    new_pane_ratio?: number;
    target?: { kind?: string; id?: string; agent_id?: string };
  };

  const kind = input.target?.kind;
  if (!kind) {
    return JSON.stringify({
      success: false,
      reason: 'missing_target',
      message: 'A navigation target with a `kind` field is required.',
    });
  }
  if (!(kind in KIND_TO_WIRE)) {
    return JSON.stringify({
      success: false,
      reason: 'invalid_kind',
      message: `Unknown target kind "${kind}". Expected one of: ${Object.keys(KIND_TO_WIRE).join(', ')}.`,
    });
  }

  const id = input.target?.id;
  // Every kind needs an id except `providers`.
  if (kind !== 'providers' && !id) {
    return JSON.stringify({
      success: false,
      reason: 'missing_id',
      message: `Target kind "${kind}" requires an \`id\`.`,
    });
  }

  const modeRaw = input.mode ?? 'split';
  if (!NAVIGATION_MODES.has(modeRaw as PaneNavigationMode)) {
    return JSON.stringify({
      success: false,
      reason: 'invalid_mode',
      message: 'mode must be either "split" or "replace".',
    });
  }
  const mode = modeRaw as PaneNavigationMode;

  const splitZoneRaw = input.split_zone ?? 'right';
  if (!SPLIT_ZONES.has(splitZoneRaw as PaneSplitZone)) {
    return JSON.stringify({
      success: false,
      reason: 'invalid_split_zone',
      message: 'split_zone must be one of: right, left, bottom, top.',
    });
  }
  const splitZone = splitZoneRaw as PaneSplitZone;

  const newPaneRatio = input.new_pane_ratio;
  if (
    newPaneRatio !== undefined &&
    (!Number.isFinite(newPaneRatio) || newPaneRatio < 0.15 || newPaneRatio > 0.85)
  ) {
    return JSON.stringify({
      success: false,
      reason: 'invalid_new_pane_ratio',
      message: 'new_pane_ratio must be a number from 0.15 to 0.85.',
    });
  }

  // Verify the target node actually exists and is the requested kind before we
  // broadcast — otherwise the navigation "succeeds" but the UI silently renders
  // "nothing selected". `providers` is a UI surface (not a workspace node), so
  // it has nothing to look up.
  if (kind !== 'providers') {
    const node = await Nodes.findById(id as string);
    if (!node || node.type !== kind) {
      return JSON.stringify({
        success: false,
        reason: 'target_not_found',
        target: { kind, id },
        message: node
          ? `Id "${id}" is a ${node.type}, not a ${kind}.`
          : `No ${kind} found with id "${id}".`,
      });
    }
  }

  // Resolve the connected client directly from the registry — no DB lookup.
  const userId = resolveAnyConnectedUserId();
  if (!userId) {
    return JSON.stringify({
      success: false,
      reason: 'no_active_client',
      message: 'No browser client is currently connected.',
    });
  }

  // Build the camelCase wire target: kind + its id field (+ optional agentId for threads).
  const wireTarget: Record<string, string> = { kind };
  if (id) wireTarget[KIND_TO_WIRE[kind]] = id;
  if (input.target?.agent_id) wireTarget.agentId = input.target.agent_id;

  const result = await emitNavigatePane({
    userId,
    command: {
      paneKey: input.pane_key ?? null,
      mode,
      splitZone,
      newPaneRatio,
      target: wireTarget as unknown as PaneNavigationTarget,
    },
    actor: {
      actorId: agentId,
      actorKind: 'agent' as const,
      actorName: agentName,
    },
  });

  if (!result.delivered) {
    return JSON.stringify({
      success: false,
      reason: 'no_active_client',
      message: 'Navigation command sent but no client received it.',
    });
  }

  return JSON.stringify({
    success: true,
    paneKey: input.pane_key ?? 'auto',
    mode,
    splitZone: mode === 'split' ? splitZone : undefined,
    newPaneRatio: mode === 'split' ? (newPaneRatio ?? 0.38) : undefined,
    targetKind: kind,
    clientsReached: result.clientCount,
    message:
      mode === 'split'
        ? `Opened ${kind} in a split pane.`
        : input.pane_key
          ? `Navigated pane "${input.pane_key}" to ${kind}.`
          : `Navigated an available pane to ${kind}.`,
  });
};

export default tool;
