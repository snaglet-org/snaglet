# get_current_datetime

Return the current date and time on the server. Agents do not have a built-in clock — use this whenever you need to reason about "today", "now", deadlines, or relative times.

## Parameters

- `timezone` (string, optional) — IANA timezone name (e.g. `America/Los_Angeles`, `UTC`, `Europe/London`). Defaults to the server's local timezone.

## Returns

A rich result with both a human-readable `output` string and a `rawContent` object containing:

| field        | type   | description                                        |
| ------------ | ------ | -------------------------------------------------- |
| `iso`        | string | ISO 8601 UTC timestamp                             |
| `unix_ms`    | number | Unix epoch in milliseconds                         |
| `unix_s`     | number | Unix epoch in seconds                              |
| `timezone`   | string | Resolved IANA timezone                             |
| `date`       | string | `YYYY-MM-DD` in the resolved timezone              |
| `weekday`    | string | Full weekday name (e.g. `Wednesday`)               |
| `human_date` | string | Long-form date (e.g. `Wednesday, January 1, 2025`) |
| `human_time` | string | Long-form time with seconds + tz abbreviation      |

## Errors

- Invalid IANA timezone → `rawContent.error = 'invalid_timezone'`.

## Examples

Default timezone:

```json
{}
```

Specific timezone:

```json
{ "timezone": "America/Los_Angeles" }
```
