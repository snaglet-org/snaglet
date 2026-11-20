# Extract PDF Text

Extract text and optional document metadata from a local PDF path or downloadable PDF URL. Returns a JSON payload as a string.

**Tier:** standard
**Type:** builtin

## Parameters

| Name              | Type    | Required | Description                                                          |
| ----------------- | ------- | -------- | -------------------------------------------------------------------- |
| `pages`           | string  | No       | Page range to extract, e.g. "1-5" or "1,3,7". Defaults to all pages. |
| `source`          | string  | Yes      | Local file path or URL to the PDF                                    |
| `includeMetadata` | boolean | No       |                                                                      |

## Example Input

```json
{
  "source": "example"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Use absolute paths for filesystem-oriented parameters unless the handler explicitly documents relative-path support.
