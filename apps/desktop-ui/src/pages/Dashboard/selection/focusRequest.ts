let sequence = 0;

/** One-shot pane seeks must remain distinct even within the same millisecond. */
export function nextFocusRequestId(): number {
  sequence += 1;
  return sequence;
}
