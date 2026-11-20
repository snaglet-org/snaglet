---
name: snaglet-search
description: Load when a search came back empty or you are unsure which search fits, before you read a long doc, or to link to part of a doc.
---

# Pick the right search call

## Which call fits

| You are looking for                      | Call                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A thing you have an id, link or path for | `search({id})` or `{ids: [...]}` (up to 20); `detail: "full"` for a doc body; `resolve_path` for a path |
| A concept, decision, doc or idea         | `search({kind: "workspace", query})`                                                                    |
| An exact title, id, name or error string | add `mode: "keyword"`                                                                                   |
| "Where did we discuss X?"                | `search({kind: "conversations", query})`                                                                |
| One old message                          | `search({kinds: ["message"], query})`                                                                   |
| Something you learned earlier            | `search({kinds: ["memory"], query})` or `memory` op `search`                                            |
| Table rows, such as tracked tasks        | `search({kinds: ["entry"], query})`                                                                     |
| Where code lives, or an exact symbol     | `kind: "files"` (meaning) or `kind: "code"` (exact)                                                     |
| A project, container or thread by name   | `search({kinds: ["container"]` or `["thread"], query})`                                                 |
| Facts from outside Snaglet               | not `search`: use `web_search`, then `web_fetch`                                                        |

## Details by kind

**Concepts, decisions and docs.** `kind: "workspace"` searches docs, messages, memories and thread summaries together, by meaning plus keywords. Narrow with `kinds: ["doc"]` if the noise is high.

**Exact strings.** With `mode: "keyword"`, quote phrases and use `OR` and `-term`. Meaning search can miss a literal string that keyword search finds at once.

**Past conversations.** `kind: "conversations"` searches thread summaries (`project_scope: "only"` keeps to this project). Read the thread with `thread` before citing it: a later reply may have reversed the decision. For one remembered message, search `kinds: ["message"]`, then `thread` op `read` with `mode: "message_context"` to see what surrounded it.

**Your own memories.** `kinds: ["memory"]` finds a preference, fact or decision that was not recalled into this turn. Check it before asking the user something they may already have answered.

**Tasks and table rows.** `search({kinds: ["entry"], query: "memories", table: "Tasks", sort: "recent"})`. Put only what to look for in `query`; "latest" means `sort: "recent"`. Filter with `filters: [{field, operator, value}]` (needs `table`). A result gives an `entry:<tableId>/<entryId>` ref (use it as the row's link) and a snippet; read the row with `table` op `read` before acting. `["entry"]` cannot be combined with other kinds.

**Files and code.** By meaning, when you don't know the filename: `kind: "files"`; an exact symbol or string: `kind: "code"`; a filename or glob: `file` op `list` with `mode: "find"`. Spelling matters: `kind: "files"` (plural, a single value) is the file backend, while `kinds: ["file"]` (singular, in a list) adds file hits to a workspace search. Both are scoped to the current project's linked folder, so neither needs a `project_id` in a project thread; `scope_files: "workspace"` searches every project. Read a file with `file` before you change it.

**By time.** Put the phrase in `query` ("created yesterday", "updated last week") or set `time_range: {from, to}` (`from` inclusive, `to` exclusive); `sort: "recent"` lists newest first.

**Projects, containers and threads.** `kinds: ["container"]` finds projects and other containers by name (a project is a container); `["thread"]` finds threads by title. These match names, not meaning.

## Long docs: outline, then read

For a long doc, don't read it all. Call `doc` op `outline` first: one entry per heading, in order, with its `level`, `text`, `line` and `anchor` (the whole part fragment, such as `#h=usage-1` or `#h3=setup`). Then read or link only the section you need: by anchor (`doc-…` plus the anchor) or by lines (`#Lstart-Lend`, the same line numbers as the outline).

## Quote only what you read

To quote, call again with the `id` and `content_range: {start_line, end_line}` (1-indexed, inclusive, up to 500 lines). It re-reads the live source, so edits since the search show up. It works for docs, messages, memories and text files.

## When results are weak

An empty result means _nothing matched_, not _nothing exists_. Change **one** thing at a time, in this order:

1. rephrase, or use the user's own words and synonyms;
2. switch `mode` (keyword for literals, hybrid for meaning);
3. widen `kinds`, or drop the filter that narrowed it;
4. widen scope: drop `project_scope: "only"`, use `scope_files: "workspace"`;
5. `include_archived: true`;
6. loosen `time_range`.

After about four tries, stop. Say what you searched and what is still unknown instead of guessing.

## Scope

`project_scope: "only"` keeps a search to the current project's docs, threads and messages; memories are outside any project, and table rows take `project_id`. Leave `graph_depth` at 0 unless you have a reason: hub nodes add noise. Fetch the few results that matter and link them; don't dump every result into your reply.

## Links to part of a doc

A link, `[Title](doc-…)`, shows the user a clickable reference they can preview or open in a pane, so link what you found rather than paste it. A link can point at part of a doc: a section heading, `[Title](doc-…#h=rate-limits)` (GitHub-style slug; `#h3=` pins the level; `#h=a..h=b` spans sections; it survives edits), lines, `#L12-L20`, or exact characters, `#L12:5-L14:30`. `search` or `doc` `get` with that id returns just that part.

Put `!` before a doc link, `![title](doc-…)`, to transclude the doc (show its content in place); the `doc` tool's description says how a transclusion behaves.

## Done when

Your answer rests on sources you fetched this turn, each linked, with anything unconfirmed said plainly.
