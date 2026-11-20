# snaglet-apple-stt — Apple on-device STT sidecar

A tiny Swift binary that wraps macOS 26's **SpeechAnalyzer / SpeechTranscriber**
on-device speech-to-text and exposes it over a pipe so the Snaglet Node server can use
it as its primary STT engine on Apple Silicon Macs.

## Why Swift (and a separate process)

SpeechAnalyzer / SpeechTranscriber are **Swift-only Apple frameworks**. They have
no C ABI, no Objective-C bridge worth speaking to from N-API, and no Node
binding — there is simply no in-process doorway from JavaScript. The only
supported way to reach them is Swift code linked against the Speech framework.
So Snaglet compiles this ~1-file Swift program and talks to it over stdio. The server
spawns **one** long-lived sidecar process and streams audio through it; native
inference stays off the Node event loop, and a crash is contained to the child.

On non-Apple platforms (or when `swiftc` / the binary is unavailable) Snaglet falls
back to its bundled local ONNX STT engine — this sidecar is a darwin-only
accelerator, never a hard dependency.

## Measured behavior

- `bestAvailableAudioFormat` = pcm16 mono **16 kHz**; the sidecar down-converts
  whatever `--rate` you feed it via `AVAudioConverter` (band-limited — no
  aliasing, unlike a naive linear resample).
- No TCC/mic prompt for file/stream transcription (no capture here — the host
  captures and streams pcm in).
- First run installs the on-device model (~4 s once); afterward ~60 ms.
- Finals land ~113 ms after end-of-speech; partials arrive endpoint-gated in
  bursts. Cased + punctuated — no post-normalization needed.
- `--hints` (contextual biasing) is plumbed but showed **no measurable effect**
  in testing — treat it as unverified.

## Build

```bash
./build.sh                     # → bin/snaglet-apple-stt  (release, -O)
# or, from the repo root:
pnpm --filter @snaglet/server stt:build
```

`bin/snaglet-apple-stt` is **gitignored** (a build artifact). It needs the macOS 26
SDK (Xcode 26 or its Command Line Tools); with an older SDK `build.sh` stops
with that message instead of compiling. On macOS 26 or later the server builds
it on demand in dev when `swiftc` is present. A desktop build (`bundle.mjs`)
builds it on the macOS 26 SDK and fails if that compile fails; with an older
SDK it records the helper as skipped (`sdkTooOld`) in `native/helpers.json`, and
that app dictates with Snaglet's local speech-to-text.

## Wire contract

```
snaglet-apple-stt stream --rate <Hz> [--hints "a,b,c"]
```

The **stream** subcommand is the primary contract: a long-lived, multi-utterance,
real-time session.

**stdin (host → sidecar)** — length-prefixed binary frames:

```
[1 byte opcode][4 byte big-endian uint32 length][length bytes payload]
  0x01 AUDIO     payload = raw little-endian pcm16 mono @ --rate
  0x02 FINALIZE  payload empty — end the current utterance, flush the analyzer
                 through end-of-input, emit exactly one {"type":"final"}, then
                 re-arm a fresh analyzer for the next utterance
  EOF          → finalize any in-flight utterance, then exit 0
```

**stdout (sidecar → host)** — newline-delimited JSON, one object per line:

```
{"type":"ready"}                                    analyzer up (assets installed)
{"type":"partial","text":..,"tMs":..,"audioMs":..}  volatile interim result
{"type":"final","text":..,"tMs":..,"audioMs":..}    one per FINALIZE
{"type":"error","code":..,"message":..}             can't run; exits 1 right after
```

`error` codes: `unsupported-os` (before macOS 26), `locale` (no English model),
`assets` (the on-device model couldn't be set up), `not-authorized` (Speech
Recognition is turned off for Snaglet in Privacy & Security), `failed` (anything
else). `warmup` reports failures the same way. The host turns the code into a
plain-language message that names the fix; `message` is Apple's own wording.

stderr carries human-readable diagnostics only (the host reads it solely to name
a failure from an older binary that sends no `error` line).

The host drives **one utterance at a time** (feed AUDIO frames → FINALIZE → read
the `final` → next), matching Snaglet's per-utterance STT session lifecycle.

### Where utterances end (dictation)

Open-mic dictation streams the mic into the sidecar continuously and needs no
Snaglet voice-detection model. The host ends an utterance after ~1 s of quiet (frame
level against the room's noise floor, plus Apple's partial text as proof that
words were heard) and sends FINALIZE; Apple then flushes its full, punctuated
text in ~30-90 ms. Apple's own phrase commits aren't used as the boundary:
measured on macOS 26 with the options above, SpeechTranscriber analyzes ~4 s
windows, commits a phrase 1-4 s after speech stops, and sometimes not until the
input ends. `SpeechDetector` (reportResults on) produced no results at all. See
`apps/server/src/services/SocketService/voiceSession/appleDictation.ts`.

### Other subcommands

- `probe` — print API availability, formats, installed locales (diagnostics).
- `warmup` — install the on-device model + resolve the analyzer format, print
  `{"type":"ready"}`, and exit. Run once at server warmup to pay the one-time
  asset-install cost up front.
- `file <in.wav> [--hints ...]` — one-shot: transcribe a wav, print a `final`
  JSON line + timing on stderr (manual/debug).
