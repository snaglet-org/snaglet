# snaglet-apple-tts — Apple on-device TTS sidecar

A tiny Swift binary that wraps macOS **AVSpeechSynthesizer** on-device
text-to-speech and exposes it over a pipe so the Snaglet Node server can offer Apple
voices (including the user-downloadable Enhanced/Premium neural voices)
alongside the bundled piper voices. Mirror of `native/apple-stt/`.

## Why Swift (and a separate process)

AVSpeechSynthesizer has no C ABI / Node binding worth reaching from N-API — the
only supported doorway is Swift linked against AVFoundation. So Snaglet compiles this
~1-file program and talks to it over stdio, spawning **one** long-lived daemon
and streaming synthesis requests through it. Native rendering stays off the Node
event loop and a crash is contained to the child.

Apple TTS is an **additive accelerator**, never a hard dependency: on non-Apple
platforms (or when `swiftc` / the binary is unavailable) Snaglet uses its bundled
piper (sherpa-onnx VITS) voices, which stay the default. `en_US-amy-medium`
(a piper voice) remains `DEFAULT_VOICE_ID` — zero Apple download required.

## The run-loop gotcha (the load-bearing detail)

`AVSpeechSynthesizer.write(_:toBufferCallback:)` delivers its PCM buffers via the
**run loop of the thread that called `write`**. Block that thread on a
`DispatchSemaphore` — the way `apple-stt` waits for its async SpeechAnalyzer
`Task` (that API is async/await, so a semaphore is fine there) — and the run loop
never turns, so **not a single buffer callback fires** and the synth silently
produces nothing.

So this sidecar does the opposite of `apple-stt`: the **main thread runs a live
run loop** (`RunLoop.current.run()`, kept from busy-spinning by a dummy Mach
port) and every `write` call + its callbacks run on that pumped main thread. A
background queue only reads stdin and hands parsed requests to main.

## Frame coalescing

AVSpeechSynthesizer hands back very fine buffers (~256 frames ≈ 11.6 ms each).
The daemon coalesces them into **~200 ms frames** (4410 samples @ 22050 Hz) to
match piper's `TTS_CHUNK_MS=200`, so the downstream pipeline sees a comparable
chunk cadence from either engine and IPC stays cheap.

## Build

```bash
./build.sh                     # → bin/snaglet-apple-tts  (release, -O)
# or, from apps/server:
pnpm --filter @snaglet/server tts:build
```

`bin/snaglet-apple-tts` is **gitignored** (a build artifact). The server builds it on
demand in dev when `swiftc` is present (see `ttsEngineResolver.ts`); packaging
stages it into the standalone bundle when it exists (darwin-only, skip-if-absent).

## Wire contract

```
snaglet-apple-tts serve          # primary contract: long-lived request/response daemon
snaglet-apple-tts list-voices    # one-shot: print installed voices as JSON, exit
```

**stdin (host → daemon)** — length-prefixed JSON request frames:

```
[4 byte big-endian uint32 length][length bytes UTF-8 JSON]
  {"cmd":"synthesize","id":<int>,"text":<str>,"voiceId":<str>}
  {"cmd":"list-voices","id":<int>}
  {"cmd":"cancel","id":<int>}      stop the in-flight synth (barge-in)
  EOF (stdin closed) → exit 0
```

**stdout (daemon → host)** — length-prefixed TAGGED frames:

```
[1 byte tag][4 byte big-endian uint32 length][length bytes payload]
  tag 0x01 AUDIO  payload = [4 byte BE id][raw little-endian FLOAT32 mono @ 22050]
  tag 0x02 END    payload = [4 byte BE id]                  synth for id complete
  tag 0x03 JSON   payload = UTF-8 JSON, one object:
      {"type":"ready"}                            daemon up, accepting requests
      {"type":"voices","id":N,"voices":[...]}     reply to list-voices; each voice
                                                  = {identifier,name,quality,lang}
                                                  quality ∈ default|enhanced|premium
      {"type":"error","id":N,"message":..}        synth/voice failure for id
```

stderr carries human-readable diagnostics only (never parsed by the host).

The host sends **float32** (not Int16) because the Node adapter owns the f32→i16
conversion (`f32ToI16` in `apps/server/src/services/voice/pcm.ts`) — keeping the
sidecar float-native avoids a lossy double-quantize and matches the STT split
(host owns the codec).
