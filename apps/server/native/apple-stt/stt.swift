import Foundation
import Speech
import AVFoundation

// snaglet-apple-stt: Snaglet's on-device speech-to-text sidecar (macOS 26+). SpeechAnalyzer
// is Swift-only, so Snaglet runs this binary over a pipe; README.md has the full
// wire contract.
//   probe   API availability, formats and installed locales
//   warmup  install the on-device model, resolve the analyzer format, exit
//   stream  long-lived: pcm16 frames in, JSON lines out (--rate R [--hints ...])
//   file    one-shot transcription of a wav (manual/debug)
// The host drives one utterance at a time; FINALIZE coalesces every phrase the
// analyzer committed since the last one into exactly one final.

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func emitJSON(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0 }

// A failure the host can name to the user. `code` picks the plain-language
// message on the host side; `detail` is Apple's own description.
struct SidecarFailure: Error {
    let code: String
    let detail: String
}

/// Report why the sidecar can't run as one `error` line (stdout) before exiting.
func emitFailure(_ error: Error) {
    var code = "failed"
    var detail = "\(error)"
    if let f = error as? SidecarFailure {
        code = f.code
        detail = f.detail
    }
    // On-device transcription doesn't need the Speech Recognition permission,
    // but if the user has turned it off for Snaglet, that's the likeliest cause of a
    // failure we can't otherwise name.
    if code == "failed" {
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .denied || status == .restricted { code = "not-authorized" }
    }
    emitJSON(["type": "error", "code": code, "message": detail])
}

// Convert an AVAudioPCMBuffer to a target format (sample-rate + common-format).
// AVAudioConverter does a proper band-limited rate conversion, so feeding the
// sidecar native-rate audio (e.g. 48 kHz) and letting Apple down-convert to the
// analyzer's 16 kHz avoids the aliasing a naive linear resample would inject.
@available(macOS 26, *)
final class Converter {
    private var converter: AVAudioConverter?
    private var lastInFmt: AVAudioFormat?
    func convert(_ buffer: AVAudioPCMBuffer, to out: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let inFmt = buffer.format
        if inFmt == out { return buffer }
        if converter == nil || lastInFmt != inFmt {
            converter = AVAudioConverter(from: inFmt, to: out)
            lastInFmt = inFmt
        }
        guard let converter else { throw NSError(domain: "conv", code: 1) }
        let ratio = out.sampleRate / inFmt.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else {
            throw NSError(domain: "conv", code: 2)
        }
        var fed = false
        var e: NSError?
        let status = converter.convert(to: outBuf, error: &e) { _, inStatus in
            if fed { inStatus.pointee = .noDataNow; return nil }
            fed = true
            inStatus.pointee = .haveData
            return buffer
        }
        if let e { throw e }
        _ = status
        return outBuf
    }
}

// Collected transcription result event.
struct EventRec { let type: String; let text: String; let tMs: Double; let audioMs: Double }

// One utterance's analyzer + transcriber + input stream + results task.
@available(macOS 26, *)
final class Engine {
    let hints: [String]
    let analyzerFormat: AVAudioFormat
    var transcriber: SpeechTranscriber!
    var analyzer: SpeechAnalyzer!
    var inputBuilder: AsyncStream<AnalyzerInput>.Continuation!
    var resultsTask: Task<Void, Never>!
    let conv = Converter()
    var t0 = nowMs()
    var events: [EventRec] = []
    var partialCount = 0
    var finalCount = 0
    // Emit partial/final lines as they arrive (stream mode). File mode leaves this
    // false and inspects `events` after the fact.
    let emitLive: Bool
    // Accumulated committed (final) phrase text for the current utterance.
    private var finalText = ""

    init(analyzerFormat: AVAudioFormat, hints: [String], emitLive: Bool) {
        self.analyzerFormat = analyzerFormat
        self.hints = hints
        self.emitLive = emitLive
    }

    func setup() async throws {
        transcriber = SpeechTranscriber(
            locale: Locale(identifier: "en-US"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        analyzer = SpeechAnalyzer(modules: [transcriber])

        // Contextual biasing (hints). The plumbing works, but no measurable effect
        // on recognition has been seen, so treat biasing as unverified.
        if !hints.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = hints
            try await analyzer.setContext(context)
        }

        let (seq, builder) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = builder

        resultsTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await result in self.transcriber.results {
                    let txt = String(result.text.characters)
                    let isFinal = result.isFinal
                    let t = nowMs() - self.t0
                    var audioMs = 0.0
                    if let r = result.text.runs.first, let range = r.audioTimeRange {
                        audioMs = range.end.seconds * 1000.0
                    }
                    if isFinal {
                        self.finalCount += 1
                        self.finalText += txt
                        // A committed phrase — surface it as a partial so the host's
                        // live preview keeps converging; the coalesced utterance
                        // final is emitted on FINALIZE (finish()).
                        if self.emitLive {
                            emitJSON(["type": "partial", "text": self.finalText,
                                      "tMs": Int(t), "audioMs": Int(audioMs)])
                        }
                    } else {
                        self.partialCount += 1
                        if self.emitLive {
                            let combined = self.finalText + txt
                            emitJSON(["type": "partial", "text": combined,
                                      "tMs": Int(t), "audioMs": Int(audioMs)])
                        }
                    }
                    self.events.append(EventRec(type: isFinal ? "final" : "partial",
                                                text: txt, tMs: t, audioMs: audioMs))
                }
            } catch {
                err("[results] error: \(error)")
            }
        }

        try await analyzer.start(inputSequence: seq)
    }

    func feed(_ data: Data, inFormat: AVAudioFormat) throws {
        let n = data.count / 2
        if n == 0 { return }
        guard let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(n)) else { return }
        buf.frameLength = AVAudioFrameCount(n)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            if let base = raw.baseAddress {
                memcpy(buf.int16ChannelData![0], base, n * 2)
            }
        }
        let converted = try conv.convert(buf, to: analyzerFormat)
        inputBuilder.yield(AnalyzerInput(buffer: converted))
    }

    // Flush the analyzer through end-of-input and return the full utterance text.
    func finish() async throws -> String {
        inputBuilder.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        _ = await resultsTask.value
        return finalText.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// analyzer format (resolved once per process)
@available(macOS 26, *)
func resolveAnalyzerFormat() async throws -> AVAudioFormat {
    let probe = SpeechTranscriber(
        locale: Locale(identifier: "en-US"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults],
        attributeOptions: [.audioTimeRange]
    )
    guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe]) else {
        throw NSError(domain: "fmt", code: 1, userInfo: [NSLocalizedDescriptionKey: "no analyzer format"])
    }
    return fmt
}

// on-device model install (idempotent; ~4 s first time, ~60 ms after)
@available(macOS 26, *)
func installAssetsIfNeeded() async throws {
    let t = SpeechTranscriber(
        locale: Locale(identifier: "en-US"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults],
        attributeOptions: [.audioTimeRange]
    )
    if await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) == nil {
        throw SidecarFailure(code: "locale", detail: "this Mac has no on-device English (US) speech model")
    }
    do {
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
            err("[asset] installing on-device model …")
            let a = nowMs()
            try await req.downloadAndInstall()
            err("[asset] installed in \(Int(nowMs() - a)) ms")
        } else {
            err("[asset] already installed")
        }
    } catch {
        throw SidecarFailure(code: "assets", detail: "\(error)")
    }
}

// stream mode (framed, multi-utterance, real-time)
enum Command { case audio(Data); case finalize; case eof }

/// Background reader: parse length-prefixed frames off stdin into Commands.
func startStdinReader(_ cont: AsyncStream<Command>.Continuation) {
    let q = DispatchQueue(label: "snaglet.apple-stt.stdin")
    q.async {
        let h = FileHandle.standardInput
        var buf = [UInt8]()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty {
                cont.yield(.eof)
                cont.finish()
                return
            }
            buf.append(contentsOf: chunk)
            // Drain every complete frame currently buffered.
            while buf.count >= 5 {
                let op = buf[0]
                let len = (Int(buf[1]) << 24) | (Int(buf[2]) << 16) | (Int(buf[3]) << 8) | Int(buf[4])
                if buf.count < 5 + len { break }
                let payload = Data(buf[5 ..< 5 + len])
                buf.removeFirst(5 + len)
                switch op {
                case 0x01: cont.yield(.audio(payload))
                case 0x02: cont.yield(.finalize)
                default: err("[stream] unknown opcode \(op)")
                }
            }
        }
    }
}

@available(macOS 26, *)
func runStream(rate: Double, hints: [String]) async throws {
    try await installAssetsIfNeeded()
    let analyzerFormat = try await resolveAnalyzerFormat()
    err("[stream] analyzer sr=\(analyzerFormat.sampleRate) ch=\(analyzerFormat.channelCount) " +
        "common=\(analyzerFormat.commonFormat.rawValue) inputRate=\(Int(rate))")
    guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                          sampleRate: rate, channels: 1, interleaved: true) else {
        throw NSError(domain: "stream", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad --rate"])
    }

    let (commands, cont) = AsyncStream<Command>.makeStream()
    startStdinReader(cont)

    var engine = Engine(analyzerFormat: analyzerFormat, hints: hints, emitLive: true)
    try await engine.setup()
    emitJSON(["type": "ready"])

    for await cmd in commands {
        switch cmd {
        case .audio(let data):
            do { try engine.feed(data, inFormat: inputFormat) }
            catch { err("[stream] feed error: \(error)") }
        case .finalize:
            let text = (try? await engine.finish()) ?? ""
            emitJSON(["type": "final", "text": text, "tMs": Int(nowMs() - engine.t0),
                      "audioMs": 0])
            // Re-arm a fresh analyzer for the next utterance (assets are warm).
            engine = Engine(analyzerFormat: analyzerFormat, hints: hints, emitLive: true)
            try await engine.setup()
        case .eof:
            let text = (try? await engine.finish()) ?? ""
            if !text.isEmpty {
                emitJSON(["type": "final", "text": text, "tMs": Int(nowMs() - engine.t0),
                          "audioMs": 0])
            }
            return
        }
    }
}

// wav reader + file mode (one-shot; manual/debug)
@available(macOS 26, *)
func readWav(_ path: String) throws -> AVAudioPCMBuffer {
    let url = URL(fileURLWithPath: path)
    let file = try AVAudioFile(forReading: url)
    let fmt = file.processingFormat
    let frames = AVAudioFrameCount(file.length)
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else {
        throw NSError(domain: "wav", code: 1)
    }
    try file.read(into: buf)
    return buf
}

@available(macOS 26, *)
func runFile(_ path: String, hints: [String]) async throws {
    try await installAssetsIfNeeded()
    let analyzerFormat = try await resolveAnalyzerFormat()
    let engine = Engine(analyzerFormat: analyzerFormat, hints: hints, emitLive: false)
    try await engine.setup()
    let buf = try readWav(path)
    let audioDurMs = Double(buf.frameLength) / buf.format.sampleRate * 1000.0
    engine.t0 = nowMs()
    let feedStart = nowMs()
    let converted = try engine.conv.convert(buf, to: analyzerFormat)
    engine.inputBuilder.yield(AnalyzerInput(buffer: converted))
    let feedDone = nowMs()
    let finalText = try await engine.finish()
    let done = nowMs()
    err("──── FILE RESULT ────")
    err("path=\(path) audioMs=\(Int(audioDurMs)) feedMs=\(Int(feedDone-feedStart)) " +
        "finalizeMs=\(Int(done-feedDone)) partials=\(engine.partialCount) finals=\(engine.finalCount)")
    err("FINAL TEXT: \(finalText)")
    emitJSON(["type": "final", "text": finalText, "tMs": Int(done - feedStart),
              "audioMs": Int(audioDurMs)])
}

// arg parsing
func parseHints(_ args: [String]) -> [String] {
    if let i = args.firstIndex(of: "--hints"), i + 1 < args.count {
        return args[i + 1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    return []
}
func parseDouble(_ args: [String], _ flag: String, _ def: Double) -> Double {
    if let i = args.firstIndex(of: flag), i + 1 < args.count { return Double(args[i + 1]) ?? def }
    return def
}

// main
let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
    err("usage: snaglet-apple-stt <probe|warmup|stream|file> ...")
    exit(2)
}

if #available(macOS 26, *) {
    let sem = DispatchSemaphore(value: 0)
    var exitCode: Int32 = 0
    Task {
        do {
            switch cmd {
            case "probe":
                let supported = await SpeechTranscriber.supportedLocales
                let installed = await SpeechTranscriber.installedLocales
                err("supported=\(supported.count) installed=\(installed.map { $0.identifier(.bcp47) })")
                let f = try await resolveAnalyzerFormat()
                err("bestFormat sr=\(f.sampleRate) ch=\(f.channelCount) common=\(f.commonFormat.rawValue)")
            case "warmup":
                try await installAssetsIfNeeded()
                _ = try await resolveAnalyzerFormat()
                emitJSON(["type": "ready"])
            case "stream":
                try await runStream(rate: parseDouble(args, "--rate", 16000), hints: parseHints(args))
            case "file":
                guard args.count >= 2 else { err("file <in.wav>"); exitCode = 2; break }
                try await runFile(args[1], hints: parseHints(args))
            default:
                err("unknown cmd \(cmd)"); exitCode = 2
            }
        } catch {
            err("ERROR: \(error)")
            emitFailure(error)
            exitCode = 1
        }
        sem.signal()
    }
    sem.wait()
    exit(exitCode)
} else {
    err("macOS 26 API unavailable")
    emitJSON(["type": "error", "code": "unsupported-os",
              "message": "Apple's on-device speech recognition needs macOS 26 or later"])
    exit(1)
}
