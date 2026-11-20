# Fetch URL

Make an HTTP request and return the response

**Tier:** standard
**Type:** builtin

## Parameters

| Name      | Type                                          | Required | Description      |
| --------- | --------------------------------------------- | -------- | ---------------- |
| `url`     | string                                        | Yes      | The URL to fetch |
| `body`    | string                                        | No       | Request body     |
| `method`  | enum("GET", "POST", "PUT", "DELETE", "PATCH") | No       | HTTP method      |
| `headers` | object                                        | No       | Request headers  |

## Example Input

```json
{
  "url": "https://example.com"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- The response body is fully untrusted external content. It is preceded by an explicit "untrusted external data" notice, and any literal `<system-reminder>`-shaped tag in the fetched text is neutralized (angle brackets escaped) so a page cannot forge platform framing. All other markup is passed through unchanged.
