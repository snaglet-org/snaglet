/**
 * Order rows by the instant an ISO timestamp names, never by its text.
 *
 * The chat receives timestamps in two forms: live frames and client-made
 * rows in UTC ("…T18:02:00.123Z"), rows read back from the database with an
 * offset ("…T10:02:00.123-08:00"). As strings those interleave wrongly, so an
 * event row could sort above the message that came before it.
 *
 * A total order, so a stable sort stays consistent: parsable values by
 * instant; unparsable or missing ones first, among themselves by text. Equal
 * instants compare equal, so a stable sort keeps their existing order.
 */
export function compareInstants(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const x = a ? Date.parse(a) : Number.NaN;
  const y = b ? Date.parse(b) : Number.NaN;
  const xOk = Number.isFinite(x);
  const yOk = Number.isFinite(y);
  if (xOk && yOk) return x === y ? 0 : x < y ? -1 : 1;
  if (xOk !== yOk) return xOk ? 1 : -1;
  const s = a ?? '';
  const t = b ?? '';
  return s < t ? -1 : s > t ? 1 : 0;
}

/** Rows (or anything with `createdAt`) oldest first; ties keep their order. */
export function byCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  return compareInstants(a.createdAt, b.createdAt);
}
