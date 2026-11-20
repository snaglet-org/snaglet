# browser

Drive a real browser. Profile `main` is a Snaglet-owned, persistent, signed-in profile; `temp` is isolated and thrown away. The user is asked to allow first use per profile (30-minute session grant available). You only see and act on tabs you opened.

Flow: `open` (url) -> `snapshot` (outline with refs `e1..eN`, max 200, valid until the next snapshot/navigation/drag) -> act by ref.

## Ops

| op                                   | Params                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `profiles`                           | list profiles                                                                     |
| `open`                               | `url`, `profile?` (default `main`)                                                |
| `tabs` / `switch` / `show`           | `tab?` (show brings the window and tab to the front)                              |
| `close`                              | `tab?` closes a tab; `profile` (+`force?`) releases that browser                  |
| `navigate`                           | `url` or `to` back/forward/reload                                                 |
| `snapshot`                           | `frame?`: url, title, frames, outline (max 200 refs), truncated                   |
| `read`                               | `ref?`, `frame?`: page text as markdown (max 12k chars)                           |
| `find`                               | `text`, `frame?`: up to 20 matching refs (refreshes refs)                         |
| `screenshot`                         | `ref?`                                                                            |
| `click` / `hover`                    | `ref` or `x,y`; `frame?`, `modifiers?`; click: `button?`, `double?`               |
| `drag`                               | `from`,`to` (ref or `{x,y}`) or `path` (max 50 waypoints); `modifiers?`           |
| `mouse`                              | `action` down/move/up/wheel, `x,y` or `dx,dy`                                     |
| `type` (appends) / `fill` (replaces) | `ref`, `text`, `frame?`; type: `submit?`                                          |
| `clear` / `check` / `uncheck`        | `ref`, `frame?` (check is state-aware)                                            |
| `press`                              | `key` taps (chords like `Control+a`); `key` or `keys` + `hold_ms` holds (below)   |
| `select`                             | `ref`, `option`, `frame?`                                                         |
| `upload`                             | `ref`, `files` (inside your project folder), `frame?`                             |
| `scroll`                             | `dy`, `dx?`, `ref?`                                                               |
| `wait`                               | `selector` / `text` / `ms` (max 15000)                                            |
| `dialog`                             | `action` accept/dismiss (omit to peek)                                            |
| `downloads`                          | list saved downloads                                                              |
| `console` / `network`                | `level?`, `clear?`: last 50 errors / failed requests, no bodies, no query strings |
| `handoff`                            | `message`: ask the user to finish a step (login, 2FA, CAPTCHA) in the window      |
| `batch`                              | `steps` (max 15): same gates per step; stops at first failure/needsApproval       |
| `pdf` / `resize` / `trace`           | pdf saves into your folder; `width,height,scale?`; trace `action` start/stop      |

Every op takes `reason` (shown beside your flower). No `eval`, cookies, storage or clipboard.

## Held keys

`press` with `hold_ms` (1-5000) keeps keys down that long, then releases them: for pages that act while a key stays down (games, drawing apps that move every animation frame). A tap is over before the next frame.

- One key: `{op:"press", key:"d", hold_ms:500}`. Several at once (all down, then all up in reverse): `{op:"press", keys:["w","d"], hold_ms:500}`, up to 4.
- Key names are Playwright's: a single character (`d`; `D` sends key "D") or a name like `ArrowUp`, `Shift`, `Space`, `Enter`, `KeyD`. Chords are not hold keys: list each one (`keys:["Shift","d"]`). Tab moves focus, so it is only tapped, never held.
- No repeat keydowns are sent while held. Keys go to the page, not the OS; keep the tab visible (`show`), since hidden tabs pause animation frames.
- The keys are released when the hold ends or the run is stopped. A dialog that opens ends the hold; its keys are released as soon as the dialog closes, whoever closes it (handle it with `dialog`). A closed tab or browser takes its keys with it. Longer moves: chain holds in `batch` (at most 15000 ms of holding per batch).

## Safety

- Never type into password / card / secret fields (no held keys there either); the user signs in via the profile sign-in flow.
- Click/press Enter (or hold Enter/Space)/select on send, delete, buy, pay, confirm, submit, post, publish... returns `needsApproval`. Before anything that sends, deletes or buys, and before submitting, posting or anything else hard to undo, ask in chat (the `ask` tool) and wait for the user's answer; the question appears next to your cursor and the user can answer by keyboard. Only after they say yes, repeat with `approved:true`.
- Site allow/block lists may apply (`SNAGLET_BROWSER_ALLOWED_SITES`, `SNAGLET_BROWSER_BLOCKED_SITES`).
