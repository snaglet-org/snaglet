# snaglet-nlp-helper — Apple on-device NLP entity/language extraction daemon

A tiny Swift binary that wraps macOS's **NaturalLanguage** framework
(`NLTagger` for named-entity recognition, `NLLanguageRecognizer` for language
detection) so the Snaglet Node server can enrich message search text with
extracted people/places/orgs on the Mac — no network call, no third-party NLP
dependency.

## Why Swift (and a separate long-lived process)

`NLTagger` / `NLLanguageRecognizer` are Swift/Objective-C-only Apple
frameworks with no Node binding, so Snaglet shells out to this ~1-file Swift
program and talks to it over stdio — the exact same shape as the
`snaglet-apple-stt` STT sidecar (see `../apple-stt/README.md`).

**Daemon, not spawn-per-call**: a probe measured spawn-per-call at
**~56ms/request** (process startup dominates a sub-millisecond extraction)
versus **~3.75ms/1KB message** against a warm process that already has its
`NLTagger`/`NLLanguageRecognizer` instances constructed. Message writes are
frequent and on a latency-sensitive path, so the Node wrapper
(`apps/server/src/services/nlp/NlpHelperClient.ts`) spawns **one** long-lived
helper process for the server's lifetime and pipes requests through it,
instead of spawning fresh per message.

On non-Apple platforms (or when `swiftc` / the binary is unavailable) Snaglet's
Node wrapper resolves to `{ entities: [], language: null }` — this helper is a
darwin-only accelerator, never a hard dependency. `messages.search_text` is a
stored generated column over the message content and `search_entity_terms`, so
keyword search indexes every message's content either way; the helper only adds
the entity terms it finds (`apps/server/src/services/NlpEntityService.ts`), and
a message with no entities skips the write.

## Build

```bash
./build.sh                     # → bin/snaglet-nlp-helper  (release, -O)
# or, from the repo root:
pnpm nlp:build
```

`bin/snaglet-nlp-helper` is **gitignored** (a build artifact). The server builds it
on demand in dev when `swiftc` is present (see
`../../src/services/nlp/nlpHelperResolver.ts`, mirroring
`sttEngineResolver.ts`); packaging (`bundle.mjs`) stages it into the
standalone bundle when it exists (darwin-only, skip-if-absent) — same pattern
as the STT sidecar.

## Wire contract

`snaglet-nlp-helper` (no subcommands) — the daemon is the entire binary. It reads
requests off stdin until EOF, then exits.

**stdin (host → helper)** — length-prefixed binary frames:

```
[4-byte big-endian uint32 length][length bytes UTF-8 text]
```

Length-prefixing (not newline-delimited) is required on the _request_ side
because message text can itself contain embedded newlines — a
newline-delimited framing would truncate or corrupt any multi-line message.

**stdout (helper → host)** — newline-delimited JSON, **one object per
request, in the same order requests arrive**:

```
{"entities":["Jane Doe","Acme Corp"],"language":"en"}
{"entities":[],"language":null}
```

JSON already escapes embedded newlines inside string values, so the response
side is safe as plain newline-delimited JSON (no length-prefix needed there,
unlike the request side).

The host (`NlpHelperClient`) drives **one request at a time** — it serializes
calls into a queue and does not write a new request frame until the previous
response line has arrived (or timed out). This means no request-id
correlation is needed: response line N always answers request N.

`entities` are deduplicated (case-insensitive per kind) `person` / `place` /
`org` strings from `NLTagger`'s `.nameType` scheme with the `.joinNames`
option (so "New York" is one entity, not "New" + "York"). `language` is the
BCP-47 dominant-language code from `NLLanguageRecognizer`, or `null` when it
can't be determined (e.g. very short text).

stderr carries no diagnostics currently (kept for parity with the STT
sidecar's `err()` helper, unused in the steady-state loop) — never parsed by
the host.
