/**
 * Renders a vision access delta into the ephemeral turn-context tail.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. It emits a SEGMENT, never a message. The caller splices it into the
 *     turn-context tail, which is marked with TURN_CONTEXT_SENTINEL and is
 *     never persisted or replayed. The previous implementation returned a
 *     `role: 'user'` message whose text matched no sentinel, so downstream
 *     classification counted it as something the human had said.
 *
 *  2. It names only tools the agent can actually call. Access being granted
 *     and a capture tool being reachable are independent facts, so when they
 *     disagree the text says capture is unavailable rather than instructing a
 *     call that would fail.
 *
 *  3. It never implies sight. Access is permission, not perception: no
 *     continuous view, no background capture, and nothing seen until a capture
 *     tool has actually returned pixels.
 */

import type { VisionAccessDelta } from './VisionThreadService';
import type { VisionFrameSource } from './VisionSnapshotService';

/**
 * The name each capture tool is reachable under for THIS agent, or null when
 * it is not routable for it at all. Resolved by the caller against the agent's
 * own tool set — a tier or catalog default is not evidence of availability.
 */
export interface VisionCaptureToolAvailability {
  screen: string | null;
  camera: string | null;
}

const HEADING = '**Vision access**';

function sourcesFor(source: 'screen' | 'camera' | 'both'): VisionFrameSource[] {
  return source === 'both' ? ['screen', 'camera'] : [source];
}

function describe(source: 'screen' | 'camera' | 'both'): string {
  return source === 'both' ? 'screen and camera' : source;
}

/**
 * Tool guidance for the currently granted source(s). Splits into "you may
 * call X", "you cannot capture", or the partial case where one granted source
 * is reachable and the other is not.
 */
function toolGuidance(
  source: 'screen' | 'camera' | 'both',
  available: VisionCaptureToolAvailability
): string {
  const granted = sourcesFor(source);
  const usable = granted.filter((s) => available[s]);
  const missing = granted.filter((s) => !available[s]);

  if (usable.length === 0) {
    return (
      `No capture tool for ${describe(source)} is available to you in this thread, so you cannot ` +
      'capture anything right now. If the user asks you to look, say that plainly instead of attempting a call.'
    );
  }

  const names = usable.map((s) => `\`${available[s]}\``).join(' or ');
  const lead =
    `Call ${names} only when the current request genuinely needs fresh visual context. ` +
    'At most one temporary frame may be captured for your turn, and it is deleted when the turn ends.';

  if (missing.length === 0) return lead;
  return `${lead} Capture for ${missing.join(' and ')} is not available to you, despite being granted.`;
}

/**
 * Build the vision segment, or null when there is nothing truthful to add.
 */
export function composeVisionAccessSegment(
  delta: VisionAccessDelta | null,
  available: VisionCaptureToolAvailability
): string | null {
  if (!delta) return null;

  const lines: string[] = [HEADING];
  const { transition, current } = delta;

  if (transition?.kind === 'enabled') {
    lines.push(
      `The user has just granted on-demand ${describe(transition.source ?? 'screen')} access for this thread. ` +
        'This is permission only — nothing is captured automatically, you cannot see the screen or camera ' +
        'continuously, and you have not been shown anything yet.'
    );
  } else if (transition?.kind === 'source-changed') {
    lines.push(
      `The user changed vision access from ${describe(transition.priorSource ?? 'screen')} to ` +
        `${describe(transition.source ?? 'screen')}. Access to the previous source is revoked and any ` +
        'temporary frames from it have been discarded.'
    );
  } else if (transition?.kind === 'revoked') {
    lines.push(
      `The user turned off vision access (previously ${describe(transition.priorSource ?? 'screen')}). ` +
        'Screen and camera capture are no longer usable until the user grants access again. ' +
        'Anything you captured earlier is gone; do not describe it as something you can still see.'
    );
  }

  if (current !== null) {
    // The compact current-state snapshot, also the whole payload for an agent
    // whose access has not changed since it last ran.
    if (!transition) lines.push(`Access is active for ${describe(current)}.`);
    lines.push(toolGuidance(current, available));
  }

  return lines.join('\n');
}
