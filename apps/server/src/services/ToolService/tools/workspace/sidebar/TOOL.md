# Sidebar

Control the native Snaglet sidebar without selecting content or changing pane layout.

- `{op: "status"}` reads confirmed `open`, `active_tab`, `width_px`.
- `{op: "open", tab: "library"}` opens a tab; omit `tab` to retain it.
  `tab: "hooks"` is an alias: it opens `automations`, where scripts are listed,
  and the reply's `active_tab` is `automations`.
- `{op: "close"}` hides the sidebar, preserving the selected tab.
- `{op: "resize", width_px: 320}` sets CSS pixel width through the existing
  width hook and localStorage preference. Finite numbers only; clamp to the same
  native 200–560 px bounds as drag/keyboard resize. Fractional pixels are retained
  during the session; the existing preference reader rounds down on reload.
  Works while closed and preserves open/tab/pane state. Returns actual `width_px`.

- `{op: "scroll", to: "bottom", duration_ms: 6000}` glides the open tab's list
  (ease-in-out, requestAnimationFrame; never the real mouse). Or pass `target`
  from inspect instead of `to` to center that row. `duration_ms` defaults to 600,
  clamps 0–10000. Replies after the animation with `scrolled`, `scroll_top`,
  `scroll_height`, `client_height`, `at_bottom`. Errors: `sidebar_closed`,
  `wrong_tab`, `node_unavailable`, `not_scrollable`.

Success is acknowledged after React commits, never optimistically from a setter.
The server ignores success responses inconsistent with the requested open/close,
optional tab, disclosure, or clamped resize state. Superseded/batched commands may
therefore time out rather than falsely succeed. No connected UI, timeout, and
unsupported/unavailable targets return structured failure. `tab` is open-only;
`width_px` is resize-only.

## Inspect mounted content

`{op: "inspect"}` adds `detail` to common status. It never fetches backend inventory.

| Tab                   | Mounted content and disclosure                                                  |
| --------------------- | ------------------------------------------------------------------------------- |
| Workspace (`library`) | Existing nested workspace rows; containers only                                 |
| Agents                | Flat roster, name/role/selection; no disclosure                                 |
| Calendar              | Calendar date-field disclosures; bound-field leaves                             |
| Providers             | LLM/Integrations sections, provider models disclosures, model leaves            |
| Tools                 | Existing tool sections/categories and tool leaves                               |
| Skills                | Skill disclosures and currently loaded file leaves; row loading/file truncation |
| Automations           | Status groups and Recent runs; automation and script leaves; never enable/run   |

New adapters return a **flat mounted row sequence**, not a fabricated hierarchy.
Entity rows use their stable semantic ID; generated groups and leaves without a genuine
entity ID use `null`. Expandable rows separately expose an opaque, mount-scoped `target`.
Workspace retains its existing nested representation; Agents stays a list.
`visibility: "mounted"` includes offscreen rows. New adapter rows additionally
return `viewport_visible` (bounding-box intersection with the sidebar panel, not
an occlusion guarantee). Collapsed descendants are absent, not inventoried.
`state`, `total_rendered`, `truncated`, selected flags and `selected_ids` describe
mounted state; snapshots cap at 250 rows. New adapter search is empty because
these lists have no shared-search filtering. Workspace/Agents retain the shared
search-control state; it does not imply the roster was filtered.
Closed/unmounted tabs return `not_rendered`; Settings and MCP inspect
return `unsupported`. These excluded tabs have no disclosure adapter.

## Idempotent disclosure

`{op: "expand", target: "<opaque reference from inspect>"}` / `collapse` changes
only disclosure. It does not click a row, navigate, select, edit, run, or enable.
Use only `expandable: true` rows. Echo `target` unchanged; never guess group IDs.
New adapter handles are mount-scoped and validated against handles actually issued
by inspect. Re-inspect after tab changes or row remounts. The tab must already be
open and the target mounted (expand ancestors first). Success returns `target`
and committed `expanded`. Repetition is harmless.

Failures: `sidebar_closed`, `wrong_tab`, `node_unavailable`, `not_container`,
`unsupported_target`, `invalid_command`, `tab_unavailable`. No fallback clicks.
