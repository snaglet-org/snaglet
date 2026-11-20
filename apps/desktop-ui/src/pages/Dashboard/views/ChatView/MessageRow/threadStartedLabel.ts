/**
 * The turn-zero thread_event row, stored as
 * "[thread started · participants: A, B · mode: mentioned]" (see
 * emitThreadStartedEvent on the server), as a person reads it: "Thread started
 * with A and B". Only the display changes; agents read the stored line.
 */
const THREAD_STARTED_PREFIX = '[thread started';
const NO_PARTICIPANTS = '(none yet)';

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The plain-English divider text for a thread-started line, or null for any other line. */
export function threadStartedLabel(content: string): string | null {
  if (!content.startsWith(THREAD_STARTED_PREFIX)) return null;
  const roster = /· participants: ([^·\]]*)/.exec(content)?.[1]?.trim() ?? '';
  const names =
    roster === NO_PARTICIPANTS
      ? []
      : roster
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
  return names.length > 0 ? `Thread started with ${joinNames(names)}` : 'Thread started';
}
