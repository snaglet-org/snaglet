# Google Gmail

Use `google_gmail` with an `operation` plus that operation's inputs. Fields not listed as
required remain optional filters or delivery settings.

| Operation       | Required inputs                                  | Legacy alias                 |
| --------------- | ------------------------------------------------ | ---------------------------- |
| `delete`        | one of `messageId`, `messageIds`                 | `google_gmail_delete`        |
| `draft_create`  | `to`, `subject`, `body`                          | `google_gmail_draft_create`  |
| `forward`       | `messageId`, `to`                                | `google_gmail_forward`       |
| `get_message`   | `messageId`                                      | `google_gmail_get_message`   |
| `list_labels`   | none                                             | `google_gmail_labels`        |
| `list`          | none                                             | `google_gmail_list`          |
| `modify_labels` | one of `messageId`, `messageIds`; a label change | `google_gmail_modify_labels` |
| `reply`         | `messageId`, `body`                              | `google_gmail_reply`         |
| `search`        | `query`                                          | `google_gmail_search`        |
| `send`          | `to`, `subject`, `body`                          | `google_gmail_send`          |
| `trash`         | one of `messageId`, `messageIds`                 | `google_gmail_trash`         |

Example: `google_gmail({ operation: "search", query: "is:unread" })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
