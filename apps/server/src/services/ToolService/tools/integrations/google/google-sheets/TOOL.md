# Google Sheets

Use `google_sheets` with an `operation` plus that operation's inputs. Ranges use A1
notation, and appended values are a two-dimensional row array.

| Operation | Required inputs                    | Legacy alias           |
| --------- | ---------------------------------- | ---------------------- |
| `append`  | `spreadsheetId`, `range`, `values` | `google_sheets_append` |
| `create`  | `title`                            | `google_sheets_create` |
| `read`    | `spreadsheetId`, `range`           | `google_sheets_read`   |

Example: `google_sheets({ operation: "read", spreadsheetId, range: "Sheet1!A1:D20" })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
