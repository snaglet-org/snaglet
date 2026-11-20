# Google Drive

Use `google_drive` for read-only lookup and downloads. Pass an `operation` plus the
operation's inputs; use `google_drive_admin` for mutations and permission changes.

| Operation          | Required inputs | Legacy alias                    |
| ------------------ | --------------- | ------------------------------- |
| `advanced_search`  | none            | `google_drive_advanced_search`  |
| `download_file`    | `fileId`        | `google_drive_download_file`    |
| `get_file`         | `fileId`        | `google_drive_get_file`         |
| `list_files`       | none            | `google_drive_list_files`       |
| `list_permissions` | `fileId`        | `google_drive_list_permissions` |
| `search_files`     | `query`         | `google_drive_search_files`     |

Example: `google_drive({ operation: "search_files", query: "Q4 budget" })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
