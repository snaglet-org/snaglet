# Status

What works today, what is in progress and what Snaglet does not do yet.

## Works today

- macOS 14 or later on Apple Silicon.
- One person and one running copy per Snaglet home.
- Agents on a model provider you connect: a hosted one with your own key or subscription, or a
  local model server.

## In progress

- **Windows.** See [Windows development](./windows-development.md).
- **The UI, tools and APIs.** They still change between versions. Database migrations carry an
  existing workspace forward.

## Not yet

- **Linux.** It does not work yet. See [Linux development](./linux-development.md).
- **Intel Macs.**
- **Automatic updates.** Snaglet tells you when a newer release is out; you download it and
  replace the app.
- **Sync between machines.**
- **Google Calendar sync.**
- **Calendar events in search.**
- **Large linked folders on an 8 GB Mac.** Indexing a folder for search by meaning takes memory.
  In testing, a folder of about 5,000 files was more than an 8 GB Mac handled well. 16 GB is
  recommended if you link large folders.
- **Keyword search in other languages.** Keyword search matches different forms of a word, such
  as "run" and "running", for English text only. Search by meaning is not affected.

Support is best effort, through
[GitHub issues](https://github.com/snaglet-org/snaglet/issues).
