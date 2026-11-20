# Generate PDF

Generate a PDF file from provided text content. HTML input is reduced to plain text before rendering.

**Tier:** standard
**Type:** builtin

## Parameters

| Name          | Type                     | Required | Description                                                                                  |
| ------------- | ------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `content`     | string                   | Yes      | HTML or Markdown content to render as PDF                                                    |
| `options`     | object                   | No       | Reserved for future renderer options. Currently ignored.                                     |
| `outputPath`  | string                   | Yes      | Where to save the generated PDF                                                              |
| `contentType` | enum("html", "markdown") | No       | Interpretation hint for the input content. HTML is converted to plain text before rendering. |

## Example Input

```json
{
  "content": "Example text",
  "outputPath": "/absolute/path/to/file.txt"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Use absolute paths for filesystem-oriented parameters unless the handler explicitly documents relative-path support.
