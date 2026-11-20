# Google Drive Admin

Use `google_drive_admin` for Drive mutations. Pass an `operation` plus the operation's
inputs. Use `google_drive` to find file, folder, and permission ids first.

| Operation           | Required inputs                      | Legacy alias                     |
| ------------------- | ------------------------------------ | -------------------------------- |
| `copy_file`         | `fileId`                             | `google_drive_copy_file`         |
| `create_folder`     | `name`                               | `google_drive_create_folder`     |
| `delete_file`       | `fileId`                             | `google_drive_delete_file`       |
| `move_file`         | `fileId`, `addParents`               | `google_drive_move_file`         |
| `rename_file`       | `fileId`, `name`                     | `google_drive_rename_file`       |
| `revoke_permission` | `fileId`, `permissionId`             | `google_drive_revoke_permission` |
| `share_file`        | `fileId`                             | `google_drive_share_file`        |
| `upload_file`       | `filePath`, or `content` with `name` | `google_drive_upload_file`       |

Example: `google_drive_admin({ operation: "rename_file", fileId, name: "Report" })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
