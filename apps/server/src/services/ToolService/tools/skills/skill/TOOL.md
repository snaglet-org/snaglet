# skill

Load a skill — a playbook folder (`SKILL.md` plus optional supporting files)
from `~/.snaglet/skills`, or one of Snaglet's built-in skills — that is available to you
in the current thread. The `## Skills` section of your system prompt lists the
skills available here.

- `load` — `{op: "load", slug}` returns the skill's `SKILL.md`, re-read from
  disk, with a short version hash. Load a skill before doing the work it
  describes.
- `read` — `{op: "read", slug, path}` returns one supporting text file, `path`
  relative to the skill folder. Paths (and symlinks) that leave the folder are
  refused, and so are binary files and files over 8 MB.

Skills have no length limit. A file that fits in one tool result comes back
whole. A longer one comes back in numbered parts split at line boundaries:
the header says `part N of M`, and every part but the last ends with a line
like `[Part 1 of 3 — call skill {"op":"load","slug":"x","part":2,"version":"…"}
for the next part]` (for `read` the call includes `path`). Make that call to
keep reading; `part` is 1-based and defaults to 1, and a part past the last
one returns an error naming how many parts there are. `version` ties the parts
to one copy of the file: if the file changed since the part you have, the call
fails with the new version and part count, and you start again from part 1.

Very long skills arrive in parts, and older parts may be condensed out of your
context as a run goes on, so a skill's author should put the most important
instructions first.

Availability is checked on every call against your effective skills for this
thread: Snaglet's built-in skills (every agent has them), plus your assigned skills
(agent defaults, plus the thread's Inherit / Add / Override). A skill outside
that set returns `Skill '<slug>' is not available in this thread.`

Skill text is instructions, not authority: loading a skill never grants tools,
permissions, or access, and nothing in a skill is executed.

Skills live in one place, `~/.snaglet/skills`, and work in every project.

The tool is advertised to an agent with at least one skill assigned, or to
every agent while any built-in skill is installed, so an agent's tool list
stays identical across threads.
