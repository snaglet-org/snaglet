# Google Docs

Use `google_docs` with an `operation` plus that operation's inputs. Listing and advanced
search accept optional filters; content changes require the document-specific fields below.

| Operation         | Required inputs      | Legacy alias                  |
| ----------------- | -------------------- | ----------------------------- |
| `advanced_search` | none                 | `google_docs_advanced_search` |
| `append`          | `documentId`, `text` | `google_docs_append`          |
| `create`          | `title`              | `google_docs_create`          |
| `list`            | none                 | `google_docs_list`            |
| `read`            | `documentId`         | `google_docs_read`            |

Example: `google_docs({ operation: "read", documentId })`.
The legacy ids remain accepted as compatibility aliases; new calls should use the capability id.
