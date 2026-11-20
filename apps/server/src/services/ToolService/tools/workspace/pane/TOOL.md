# Pane

Drive the user's live UI: split or navigate panes so you surface the exact context you're discussing instead of only describing it.

**Tier:** core
**Type:** builtin

## The user's screen

The user is looking at a live split-pane workspace — an actual screen, not just this thread. Call `pane {op: "layout"}` to read the panes they currently have open; each pane is tagged with its `[key=…]` and a flag like `[active]` marking the pane that shows the conversation you're in.

Call `pane {op: "navigate"}` to open a workspace node (doc, thread, container, tool, image, or the providers list). It defaults to splitting the current pane so the user's chat stays visible.

## Parameters

- `target` (required) — `{ kind, id }`, e.g. `{ kind: 'doc', id: 'doc-123' }`. `kind` is one of `doc | thread | container | tool | image | providers`; `id` is that node's id (optional only for `providers`). For `kind: 'thread'` you may add `agent_id` to focus a specific agent.
- `mode` (optional) — `split | replace`. Defaults to `split`. Use `replace` only when intentionally navigating an existing non-chat pane.
- `pane_key` (optional) — a pane key from `pane {op: "layout"}`. In `split` mode, this is the pane to split; in `replace` mode, this is the pane to replace.
- `split_zone` (optional) — `right | left | bottom | top`. Defaults to `right`.
- `new_pane_ratio` (optional) — fraction of the split allocated to the new pane, from `0.15` to `0.85`. Use `0.25`-`0.35` for a narrow side pane.

## Default behavior

For "show/open this" requests, use the default split behavior. It preserves the pane flagged `[active]`, which is the thread the user is talking to you in.

- Prefer `mode: "split"` unless the user explicitly asks to replace a view.
- To show something beside the current chat, omit `pane_key` or pass the `[active]` pane key with `mode: "split"`.
- Use `mode: "replace"` only for a non-active pane or when the user clearly asked you to navigate away.
- Repeat split calls when a multi-view layout is useful.

Call `pane {op: "layout"}` to read the panes mid-run whenever you need the user's current layout.
