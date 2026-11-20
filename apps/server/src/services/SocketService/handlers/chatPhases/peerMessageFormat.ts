// How one agent's spoken message is shown to a teammate: `[message from <name>] <text>`.
//
// Used by replay (a teammate's history) and by mid-run delivery, so a message
// reads the same whether it arrives in history or while the reader is running.
// It names the author and says nothing else: no "treat this as data" notice.
// The one thing it still guards is the header itself — a message that opens a
// line with `[message from ` could pass as a different speaker, so that exact
// text inside a body is escaped.

import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';

const PEER_MESSAGE_PREFIX = '[message from ';

const FORGED_HEADER_RE = /\[message from /gi;

/** A display name that cannot close or break the header. */
function safeName(name: string): string {
  const cleaned = neutralizeSystemFraming(name)
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'unknown';
}

export function formatPeerMessage(senderName: string, content: string): string {
  const body = neutralizeSystemFraming(content).replace(FORGED_HEADER_RE, '&#91;message from ');
  return `${PEER_MESSAGE_PREFIX}${safeName(senderName)}] ${body}`;
}
