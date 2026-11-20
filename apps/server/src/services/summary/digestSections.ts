/**
 * The thread digest grows by appending, never by rewriting: each pass summarizes only the messages
 * since the last one and adds the result as a new section, so an earlier section stays exactly as
 * it was written and a mistake in one pass cannot compound into the next (a pass that rewrote the
 * previous summary drifted, and once reversed a decision).
 *
 * The digest feeds search, embeddings and the thread list, so it is capped; past the cap the oldest
 * sections go first, whole, with a marker. The messages themselves stay searchable.
 */

/** Most characters a stored digest keeps (the embedding input stays bounded). */
export const DIGEST_MAX_CHARS = 24_000;

/** Where older sections were dropped. */
export const DIGEST_OMITTED_MARKER = '[Earlier sections omitted]';

const SECTION_BREAK = '\n\n';

export function appendDigestSection(prior: string | null | undefined, section: string): string {
  const added = section.trim();
  const earlier = (prior ?? '').trim();
  if (!earlier) return added;

  const sections = earlier
    .split(SECTION_BREAK)
    .filter((part) => part.trim() && part.trim() !== DIGEST_OMITTED_MARKER);
  const hadOmitted = earlier.startsWith(DIGEST_OMITTED_MARKER);
  const render = (parts: string[], omitted: boolean): string =>
    [...(omitted ? [DIGEST_OMITTED_MARKER] : []), ...parts, added].join(SECTION_BREAK);

  let dropped = hadOmitted;
  let kept = sections;
  let text = render(kept, dropped);
  while (text.length > DIGEST_MAX_CHARS && kept.length > 0) {
    kept = kept.slice(1);
    dropped = true;
    text = render(kept, dropped);
  }
  return text;
}
