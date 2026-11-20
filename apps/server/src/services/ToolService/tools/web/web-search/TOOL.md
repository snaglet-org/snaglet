# Search Web

Search the web through the DuckDuckGo HTML results page and return titles,
URLs, and snippets for the top results. No API key is needed or read.

**Tier:** standard
**Type:** builtin

## Parameters

| Name    | Type    | Required | Description                                   |
| ------- | ------- | -------- | --------------------------------------------- |
| `query` | string  | Yes      | The search query                              |
| `num`   | integer | No       | Number of results to return (1-10, default 5) |

## Example Input

```json
{
  "query": "search term"
}
```

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- `num` is floored and clamped to 1-10; a missing or non-numeric value uses 5. The legacy `max_results` name is still accepted.
- DuckDuckGo often answers automated requests with a bot-challenge ("anomaly") page instead of results, currently as HTTP 202. The tool throws a "blocked by the search provider" error for a challenge page and a "failed" error for any other non-200 status, so an agent never mistakes a block for an empty result. A 200 page counts as a challenge only when no results parsed, so a real result that quotes the challenge text is still returned. The tool does not spoof a browser user agent or otherwise try to get past the challenge.
- The request is capped at 15 seconds and throws a "timed out" error when the provider does not answer in time. A network failure (DNS, offline, connection refused) throws a "could not reach the search provider" error naming the low-level code (e.g. `ENOTFOUND`). The request also stops when the run is stopped.
- The blocked, failed, timed-out, and network errors all point the agent to a connected search MCP server such as Firecrawl.
- "No results found for: …" is returned only for a real 200 results page with no results on it.
- The returned results are fully untrusted external content. They are preceded by an explicit "untrusted external data" notice, and any literal `<system-reminder>`-shaped tag is neutralized (angle brackets escaped) via the shared `untrustedContent` util so a search-result page cannot forge platform framing. Snippet text is never re-decoded from `&lt;`/`&gt;` entities back into literal angle brackets — that reconstructs exactly the tag shape being guarded against.
