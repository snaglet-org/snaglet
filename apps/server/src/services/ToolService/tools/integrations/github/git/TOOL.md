# Git

Run bounded Git commands through one capability tool.

**Tier:** standard
**Type:** builtin

## Subcommands

- `branch`
- `checkout`
- `commit`
- `diff`
- `log`
- `pull`
- `push`
- `stash`
- `status`
- `verify`

The previous `git-*` tool IDs remain permanent aliases for these subcommands.
Canonical and aliased calls use the same `git:*` permission rules.

## Notes

- Before reporting any commit SHA or ref, resolve it with the `verify`
  subcommand instead of trusting a remembered value — a quoted SHA that was
  never verified is a fabricated ID.
