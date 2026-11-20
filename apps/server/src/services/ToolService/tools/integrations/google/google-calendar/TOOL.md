# Google Calendar

Use `google_calendar` with an `operation` plus that operation's inputs. Calendar ids
default to the primary calendar where the operation supports that default.

| Operation        | Required inputs                    | Legacy alias                     |
| ---------------- | ---------------------------------- | -------------------------------- |
| `create_event`   | `summary`, `start`, `end`          | `google_calendar_create_event`   |
| `delete_event`   | `eventId`                          | `google_calendar_delete_event`   |
| `get_event`      | `eventId`                          | `google_calendar_get_event`      |
| `get_freebusy`   | `timeMin`, `timeMax`               | `google_calendar_get_freebusy`   |
| `list_calendars` | none                               | `google_calendar_list_calendars` |
| `list_events`    | none                               | `google_calendar_list_events`    |
| `search_events`  | `query`                            | `google_calendar_search_events`  |
| `update_event`   | `eventId` plus at least one change | `google_calendar_update_event`   |

Example: `google_calendar({ operation: "list_events", timeMin, timeMax })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
