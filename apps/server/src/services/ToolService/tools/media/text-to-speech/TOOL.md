# Text to Speech

Convert text into spoken audio with OpenAI text-to-speech. Saves audio to outputPath when provided, otherwise returns base64 audio data.

**Tier:** standard
**Type:** builtin

## Parameters

| Name         | Type                                                      | Required | Description                                    |
| ------------ | --------------------------------------------------------- | -------- | ---------------------------------------------- |
| `text`       | string                                                    | Yes      | Text to convert to speech                      |
| `speed`      | number                                                    | No       |                                                |
| `voice`      | enum("alloy", "echo", "fable", "onyx", "nova", "shimmer") | No       |                                                |
| `format`     | enum("mp3", "opus", "aac", "flac")                        | No       |                                                |
| `outputPath` | string                                                    | No       | Optional file path to save the generated audio |

## Example Input

```json
{
  "text": "Example text"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Use absolute paths for filesystem-oriented parameters unless the handler explicitly documents relative-path support.
