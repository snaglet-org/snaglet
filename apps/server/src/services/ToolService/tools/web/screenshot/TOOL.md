# Screenshot URL

Capture a screenshot of a web page at a given URL and **view** it: the bytes
are attached inline to the tool result as a real image content block, so
vision-capable models see the actual pixels this same turn — no follow-up
"open" call.

**Tier:** standard
**Type:** builtin

## Parameters

| Name     | Type   | Required | Description               |
| -------- | ------ | -------- | ------------------------- |
| `url`    | string | Yes      | The URL to screenshot     |
| `width`  | number | No       | Viewport width in pixels  |
| `height` | number | No       | Viewport height in pixels |

## Example Input

```json
{
  "url": "https://example.com"
}
```

## Output

A one-line confirmation naming the new workspace image id — **no filesystem
path** — with the image bytes attached inline to the same tool result:

```
captured, image id image-1781234567890-abc123
```

If Playwright is unavailable, falls back to a text summary of the page
(title + stripped body text) instead of failing outright.

## Notes

- The captured image auto-places into the calling thread's workspace
  container (same rule `image_generate` uses) — it shows up in the tree next
  to the rest of that thread's work. Falls back to unplaced (`containerId:
null`) only when the thread has no container, or there's no thread context
  at all (e.g. a headless run). Reference it later with `<image id="…"/>` or
  `file(op:read, mode:image)` (pass the id as `id`).
- Saved images are tagged `tool-capture`. Unplaced tool-captures are
  not purged automatically.
- Inline viewing requires a provider that supports images in tool results
  (Anthropic models). On other providers the text confirmation still arrives
  and the saved image id remains usable.
- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
