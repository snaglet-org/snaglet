/**
 * Guards for caller-supplied git operands (remotes, branches, refs).
 *
 * execFile already keeps shell metacharacters literal, but git parses its own
 * argv: a "remote" of `--upload-pack=<cmd>` runs `<cmd>`, and a "ref" of
 * `--output=<file>` makes `git log` overwrite that file. Two layers stop this:
 *
 *  1. `gitOperand` rejects any value that starts with `-`. This is the layer
 *     that matters for `git pull`, which re-spawns `git fetch` and passes the
 *     remote along WITHOUT an end-of-options marker — so `--end-of-options`
 *     on `pull` itself does not protect the fetch child.
 *  2. Callers place `--end-of-options` (git >= 2.24) before operands so that
 *     git's option parser stops even if a future caller forgets layer 1.
 *     Pathspecs go after `--`, as before.
 */

export const END_OF_OPTIONS = '--end-of-options';

/**
 * Return `value` unchanged when it is safe to pass as a git operand, else
 * throw. `label` names the tool parameter in the error.
 */
export function gitOperand(label: string, value: string): string {
  if (value.startsWith('-')) {
    throw new Error(`${label} must not start with "-" (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** `gitOperand` for optional parameters. */
export function optionalGitOperand(label: string, value: string | null | undefined): string | null {
  return value ? gitOperand(label, value) : null;
}
