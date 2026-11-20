# Extract Text from Image

Extract text from a local image path or downloadable image URL using the macOS Vision OCR pipeline.

**Tier:** standard
**Type:** builtin

## Parameters

| Name        | Type     | Required | Description                                                         |
| ----------- | -------- | -------- | ------------------------------------------------------------------- |
| `source`    | string   | Yes      | Local file path or URL to the image                                 |
| `language`  | string   | No       | Expected language hint (e.g. en, ja, zh). Auto-detected if omitted. |
| `languages` | string[] | No       | Optional list of OCR language hints                                 |

## Example Input

```json
{
  "source": "example"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Use absolute paths for filesystem-oriented parameters unless the handler explicitly documents relative-path support.
