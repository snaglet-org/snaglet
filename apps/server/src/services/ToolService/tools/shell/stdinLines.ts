/**
 * The command lines a shell(op:write) would submit, shared by the tool-access
 * guard (lib/toolPermission.ts) and the git rail (shellWrite.ts) so the two can
 * never read different text.
 *
 * `pending` is the session's unfinished line (text after the last newline of
 * earlier writes). A `\`+newline continuation is joined first, so `r\` +
 * `m -rf x` reads as `rm -rf x`. Lines split on \r\n, \r or \n (a bare \r is
 * stricter than bash, which only adds denies/asks). The trailing unfinished
 * part is included too: it is checked now and again once it is completed.
 */
export interface StdinLines {
  /** Non-blank lines to authorize, unfinished tail included. */
  lines: string[];
  /** The unfinished line the session holds after this write succeeds. */
  nextPending: string;
}

export function stdinCommandLines(pending: string, chars: string): StdinLines {
  const joined = (pending + chars).replace(/\\(?:\r\n|\r|\n)/g, '');
  const parts = joined.split(/\r\n|\r|\n/);
  const nextPending = parts[parts.length - 1] ?? '';
  // A trailing lone `\` stays in nextPending, so the next write's newline
  // joins it on the following check.
  return {
    lines: parts.map((line) => line.trim()).filter(Boolean),
    nextPending,
  };
}
