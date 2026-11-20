# Generate Image

Generate an image from a text prompt using whichever image-capable provider has a configured credential. The result is saved to the workspace images table and attached inline to the tool result, so vision-capable agents **see what they generated** on the same turn and can iterate.

**Tier:** standard
**Type:** builtin

## Providers

| Provider   | Model                                  | Notes                                            |
| ---------- | -------------------------------------- | ------------------------------------------------ |
| `openai`   | `gpt-image-1` (falls back to DALL-E 3) | Fallback triggers on access errors (org-verify). |
| `gemini`   | `gemini-2.5-flash-image`               | Ignores `size`/`style` — the model chooses.      |
| `together` | `black-forest-labs/FLUX.1-schnell`     | `size` mapped to explicit width/height.          |

`provider: "auto"` (the default) picks the first of openai → gemini → together with a configured credential. Anthropic, Mistral, Copilot, Ollama, and LM Studio have no image-generation APIs.

## Parameters

| Name           | Type   | Required | Description                                                           |
| -------------- | ------ | -------- | --------------------------------------------------------------------- |
| `prompt`       | string | Yes      | Text description of the image to generate                             |
| `provider`     | string | No       | `auto` (default), `openai`, `gemini`, or `together`                   |
| `size`         | string | No       | `1024x1024` (default), `1792x1024`, `1024x1792`, `512x512`, `256x256` |
| `style`        | string | No       | `vivid` (default) or `natural` — DALL-E 3 only                        |
| `container_id` | string | No       | File the image into this container; defaults to the thread's project  |

## Example Input

```json
{ "prompt": "a watercolor heron at dawn", "size": "1024x1792" }
```

## Output

A short summary naming the saved workspace image id, provider/model used, and any provider-revised prompt — with the image bytes attached inline (when ≤ 5 MB) so the agent can inspect the result.

## Notes

- **Show the user:** include the returned `<image id="…"/>` marker in your reply — the thread UI renders it.
- **Placement:** the image is filed into the Images container of the calling thread's project (created on first use), or the root Images container for a flat thread. `container_id` only selects which project's Images container; move the image afterward to file it elsewhere.
- **Lifecycle:** images are tagged `tool-capture` + `generated` and kept permanently, since every new image is filed.
- Inline viewing requires a provider that supports images in tool results (Anthropic models); others still get the text summary and the saved id.
- Mime type is detected from the returned bytes, not trusted from the API.
