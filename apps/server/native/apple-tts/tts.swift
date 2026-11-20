// snaglet-apple-tts: Snaglet's on-device text-to-speech sidecar (macOS). AVSpeechSynthesizer
// has no Node/C doorway, so the server runs one long-lived daemon over a pipe
// (the native/apple-stt pattern), keeping rendering off the Node event loop.
//
// Run loop: `write(_:toBufferCallback:)` delivers buffers on the run loop of the
// calling thread, so blocking that thread (as apple-stt does with a semaphore)
// means no callback ever fires. Here the main thread runs a live run loop and
// does every `write`; a background queue only reads stdin and hands requests to
// main. Tiny callback buffers are coalesced into ~200 ms frames (piper's chunk
// size) so the pipe isn't flooded.

// Wire protocol. stdin: [u32 BE length][UTF-8 JSON], one of
//   {"cmd":"synthesize","id","text","voiceId"} | {"cmd":"list-voices","id"}
//   | {"cmd":"cancel","id"}; EOF exits 0.
// stdout: [1-byte tag][u32 BE length][payload]
//   0x01 AUDIO [u32 BE id][float32 LE mono @ 22050]  (the host owns f32→i16)
//   0x02 END   [u32 BE id]
//   0x03 JSON  {"type":"ready"} | {"type":"voices","id","voices"}
//              | {"type":"error","id","message"}
// stderr is diagnostics only.

#if canImport(AVFoundation)
import Foundation
import AVFoundation

// Piper renders at 22050 Hz; we hand the pipeline float32 mono @ 22050 so both
// engines feed the same downstream sample rate (see VOICE_TTS_DEFAULT_SAMPLE_RATE).
let TTS_SAMPLE_RATE = 22_050.0
// ~200 ms @ 22050 Hz = 4410 samples — matches piper's TTS_CHUNK_MS=200.
let COALESCE_SAMPLES = 4_410

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// stdout is binary (framed) — never `print()` to it. All writes happen on the
// main thread (synthesis callbacks + list-voices are main-thread), so framed
// writes never interleave.
let outHandle = FileHandle.standardOutput

func writeFrame(tag: UInt8, payload: Data) {
    var header = Data([tag, 0, 0, 0, 0])
    var beLen = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &beLen) { header.replaceSubrange(1..<5, with: $0) }
    outHandle.write(header)
    if !payload.isEmpty { outHandle.write(payload) }
}

func writeJSON(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj) {
        writeFrame(tag: 0x03, payload: d)
    }
}

func idPayload(_ id: UInt32, appending extra: Data = Data()) -> Data {
    var p = Data([0, 0, 0, 0])
    var beId = id.bigEndian
    withUnsafeBytes(of: &beId) { p.replaceSubrange(0..<4, with: $0) }
    if !extra.isEmpty { p.append(extra) }
    return p
}

func writeAudio(id: UInt32, floats: [Float]) {
    if floats.isEmpty { return }
    let bytes = floats.withUnsafeBytes { Data($0) } // little-endian on x86_64/arm64
    writeFrame(tag: 0x01, payload: idPayload(id, appending: bytes))
}

func writeEnd(id: UInt32) {
    writeFrame(tag: 0x02, payload: idPayload(id))
}

// AVSpeechSynthesizer may hand buffers in a non-canonical format (Int16, a
// different rate, stereo). Normalize every buffer to float32 mono @ 22050 via
// AVAudioConverter (band-limited — mirrors apple-stt's Converter) so the host
// always receives one predictable format.
@available(macOS 10.15, *)
final class Converter {
    private var converter: AVAudioConverter?
    private var lastInFmt: AVAudioFormat?
    let canonical = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: TTS_SAMPLE_RATE,
        channels: 1, interleaved: false)!

    func floats(from buffer: AVAudioPCMBuffer) -> [Float] {
        let inFmt = buffer.format
        // Fast path: already canonical (the common case — write() renders 22050
        // float32 mono on modern macOS).
        if inFmt.commonFormat == .pcmFormatFloat32,
           Int(inFmt.sampleRate) == Int(TTS_SAMPLE_RATE),
           inFmt.channelCount == 1,
           let ch = buffer.floatChannelData {
            return Array(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength)))
        }
        if converter == nil || lastInFmt != inFmt {
            converter = AVAudioConverter(from: inFmt, to: canonical)
            lastInFmt = inFmt
        }
        guard let converter else { return [] }
        let ratio = canonical.sampleRate / inFmt.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: cap) else {
            return []
        }
        var fed = false
        var convErr: NSError?
        converter.convert(to: outBuf, error: &convErr) { _, inStatus in
            if fed { inStatus.pointee = .noDataNow; return nil }
            fed = true
            inStatus.pointee = .haveData
            return buffer
        }
        if convErr != nil { return [] }
        guard let ch = outBuf.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: ch[0], count: Int(outBuf.frameLength)))
    }
}

struct SynthRequest { let id: UInt32; let text: String; let voiceId: String }
enum Request { case synthesize(SynthRequest); case listVoices(UInt32); case cancel(UInt32) }

/// Map AVSpeechSynthesisVoiceQuality → the host's tier string. Read via rawValue
/// so `.premium` (macOS 13+) needs no compile-time availability gate.
func qualityString(_ q: AVSpeechSynthesisVoiceQuality) -> String {
    switch q.rawValue {
    case 3: return "premium"
    case 2: return "enhanced"
    default: return "default"
    }
}

// One AVSpeechSynthesizer, driven serially on the pumped main thread. Only one
// synthesis renders at a time (Apple does not support concurrent writes on one
// synthesizer); extra requests queue and run FIFO — mirroring how the host
// awaits END before sending the next.
@available(macOS 10.15, *)
final class TtsDaemon {
    private let synth = AVSpeechSynthesizer()
    private let conv = Converter()
    private var pending: [Request] = []
    private var busy = false
    private var accum: [Float] = []
    private var currentId: UInt32 = 0

    func enqueue(_ req: Request) {
        // A cancel targets the in-flight synth immediately, not the queue tail.
        if case .cancel(let id) = req, busy, id == currentId {
            synth.stopSpeaking(at: .immediate)
            finishSynth() // flush + END + advance
            return
        }
        pending.append(req)
        pump()
    }

    private func pump() {
        guard !busy, !pending.isEmpty else { return }
        let req = pending.removeFirst()
        switch req {
        case .listVoices(let id):
            handleListVoices(id: id)
            pump()
        case .cancel:
            pump() // nothing in flight — a stale cancel is a no-op
        case .synthesize(let r):
            busy = true
            startSynth(r)
        }
    }

    private func handleListVoices(id: UInt32) {
        let voices = AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
            [
                "identifier": v.identifier,
                "name": v.name,
                "quality": qualityString(v.quality),
                "lang": v.language,
            ]
        }
        writeJSON(["type": "voices", "id": Int(id), "voices": voices])
    }

    private func startSynth(_ r: SynthRequest) {
        currentId = r.id
        accum.removeAll(keepingCapacity: true)

        let utt = AVSpeechUtterance(string: r.text)
        if !r.voiceId.isEmpty, let v = AVSpeechSynthesisVoice(identifier: r.voiceId) {
            utt.voice = v
        } else if !r.voiceId.isEmpty {
            // Unknown identifier — surface an error and end this request cleanly
            // rather than silently substituting a different voice.
            writeJSON(["type": "error", "id": Int(r.id),
                       "message": "unknown voice identifier: \(r.voiceId)"])
            writeEnd(id: r.id)
            busy = false
            pump()
            return
        }
        // else: empty voiceId → the system default voice.

        let id = r.id
        // write()'s callback runs on this (main) thread's run loop — see the
        // run-loop gotcha header. AVSpeechSynthesizer signals completion by
        // invoking the callback once with a zero-length buffer.
        synth.write(utt) { [weak self] buffer in
            guard let self else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                self.finishSynth()
                return
            }
            self.append(pcm, id: id)
        }
    }

    private func append(_ pcm: AVAudioPCMBuffer, id: UInt32) {
        guard id == currentId else { return } // stale buffer from a canceled synth
        accum.append(contentsOf: conv.floats(from: pcm))
        while accum.count >= COALESCE_SAMPLES {
            let frame = Array(accum.prefix(COALESCE_SAMPLES))
            accum.removeFirst(COALESCE_SAMPLES)
            writeAudio(id: id, floats: frame)
        }
    }

    // Flush the coalescing remainder, emit END, and advance the queue.
    private func finishSynth() {
        guard busy else { return }
        if !accum.isEmpty {
            writeAudio(id: currentId, floats: accum)
            accum.removeAll(keepingCapacity: true)
        }
        writeEnd(id: currentId)
        // Clear currentId so a late write() callback for this finished/canceled
        // synth (Node ids start at 1, so 0 is never live) can't emit a stray
        // AUDIO frame past END. The next synth resets it in startSynth.
        currentId = 0
        busy = false
        pump()
    }
}

// stdin reader: length-prefixed JSON request frames, parsed off-main.
func startStdinReader(_ onRequest: @escaping (Request) -> Void) {
    let q = DispatchQueue(label: "snaglet.apple-tts.stdin")
    q.async {
        let h = FileHandle.standardInput
        var buf = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty {
                DispatchQueue.main.async { exit(0) } // EOF — clean shutdown
                return
            }
            buf.append(chunk)
            // Drain every complete frame currently buffered.
            while buf.count >= 4 {
                let len = (Int(buf[buf.startIndex]) << 24)
                    | (Int(buf[buf.startIndex + 1]) << 16)
                    | (Int(buf[buf.startIndex + 2]) << 8)
                    | Int(buf[buf.startIndex + 3])
                if buf.count < 4 + len { break }
                let payload = buf.subdata(in: (buf.startIndex + 4)..<(buf.startIndex + 4 + len))
                buf.removeSubrange(buf.startIndex..<(buf.startIndex + 4 + len))
                if let req = parseRequest(payload) {
                    DispatchQueue.main.async { onRequest(req) }
                }
            }
        }
    }
}

func parseRequest(_ payload: Data) -> Request? {
    guard
        let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
        let cmd = obj["cmd"] as? String
    else {
        err("[stdin] malformed request frame")
        return nil
    }
    let id = UInt32((obj["id"] as? Int) ?? 0)
    switch cmd {
    case "synthesize":
        let text = (obj["text"] as? String) ?? ""
        let voiceId = (obj["voiceId"] as? String) ?? ""
        return .synthesize(SynthRequest(id: id, text: text, voiceId: voiceId))
    case "list-voices":
        return .listVoices(id)
    case "cancel":
        return .cancel(id)
    default:
        err("[stdin] unknown cmd \(cmd)")
        return nil
    }
}

// Main
let args = Array(CommandLine.arguments.dropFirst())
let sub = args.first ?? "serve"

if #available(macOS 10.15, *) {
    switch sub {
    case "list-voices":
        // One-shot mode (diagnostics): print the installed voices and exit.
        let voices = AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
            ["identifier": v.identifier, "name": v.name,
             "quality": qualityString(v.quality), "lang": v.language]
        }
        writeJSON(["type": "voices", "id": 0, "voices": voices])
        exit(0)
    case "serve":
        let daemon = TtsDaemon()
        startStdinReader { daemon.enqueue($0) }
        writeJSON(["type": "ready"])
        // Keep the main run loop alive so write()'s buffer callbacks are pumped
        // (see the run-loop gotcha header). A bare RunLoop.run() with no input
        // source busy-spins; a dummy Mach port gives it a source to sleep on.
        RunLoop.current.add(Port(), forMode: .default)
        RunLoop.current.run()
    default:
        err("usage: snaglet-apple-tts <serve|list-voices>")
        exit(2)
    }
} else {
    err("macOS 10.15+ required for AVSpeechSynthesizer.write")
    exit(1)
}

#else
// Non-Apple platform: build.sh never compiles this off-Darwin; the stub is a
// fallback, and the resolver uses piper (the default) instead.
import Foundation
FileHandle.standardError.write("snaglet-apple-tts requires AVFoundation (macOS)\n".data(using: .utf8)!)
exit(1)
#endif
