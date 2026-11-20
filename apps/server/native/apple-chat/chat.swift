import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// snaglet-apple-chat: Snaglet's on-device chat sidecar over Apple's FoundationModels
// (macOS 26+). The framework is Swift-only, so Snaglet runs this binary over a pipe.
//   availability  print SystemLanguageModel availability as one JSON line, exit.
//   chat          long-lived; many requests in flight (one per Snaglet session).
// Without FoundationModels, or below macOS 26, a stub always reports
// "unavailable" and the Node resolver hides the provider.

// Chat wire protocol, one JSON object per line (stdout flushed per line):
//   in:  {"id","prompt","instructions"?,"maxTokens"?} or {"id","cancel":true}
//        `prompt` is the full rendered turn; nothing is kept between calls.
//   out: {"type":"ready"} once, then per request {"type":"token","id","text"},
//        {"type":"done","id","stopReason":"end_turn"|"aborted"} or
//        {"type":"error","id","message"}. stderr is diagnostics only.

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func emitJSON(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

// One parsed request line.
struct ChatRequest {
    let id: String
    let prompt: String
    let instructions: String?
    let maxTokens: Int?
    let cancel: Bool
}

func parseRequest(_ line: String) -> ChatRequest? {
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = obj["id"] as? String
    else { return nil }
    if (obj["cancel"] as? Bool) == true {
        return ChatRequest(id: id, prompt: "", instructions: nil, maxTokens: nil, cancel: true)
    }
    guard let prompt = obj["prompt"] as? String else { return nil }
    let instructions = obj["instructions"] as? String
    let maxTokens = obj["maxTokens"] as? Int
    return ChatRequest(id: id, prompt: prompt, instructions: instructions, maxTokens: maxTokens, cancel: false)
}

// stdin: newline-delimited JSON reader on a background queue.
enum ChatCommand {
    case request(ChatRequest)
    case malformed
    case eof
}

func startStdinLineReader(_ cont: AsyncStream<ChatCommand>.Continuation) {
    let q = DispatchQueue(label: "snaglet.apple-chat.stdin")
    q.async {
        let h = FileHandle.standardInput
        var buf = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty {
                cont.yield(.eof)
                cont.finish()
                return
            }
            buf.append(chunk)
            while let nl = buf.firstIndex(of: 0x0A) {
                let lineData = buf.subdata(in: buf.startIndex..<nl)
                buf.removeSubrange(buf.startIndex...nl)
                guard let line = String(data: lineData, encoding: .utf8) else { continue }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                if let req = parseRequest(trimmed) {
                    cont.yield(.request(req))
                } else {
                    cont.yield(.malformed)
                }
            }
        }
    }
}

#if canImport(FoundationModels)

/// Tracks in-flight generation Tasks by request id so a `{"cancel":true}`
/// line can cooperatively cancel the right one. Plain actor — no
/// FoundationModels dependency, just guards concurrent dictionary access
/// from the many concurrent per-request Tasks below.
actor RunningTasks {
    private var tasks: [String: Task<Void, Never>] = [:]
    func set(_ id: String, _ task: Task<Void, Never>) { tasks[id] = task }
    func cancel(_ id: String) { tasks[id]?.cancel() }
    func clear(_ id: String) { tasks[id] = nil }
}

@available(macOS 26, *)
func availabilityJSON() -> [String: Any] {
    switch SystemLanguageModel.default.availability {
    case .available:
        return ["type": "availability", "available": true]
    case .unavailable(let reason):
        let reasonStr: String
        switch reason {
        case .deviceNotEligible: reasonStr = "deviceNotEligible"
        case .appleIntelligenceNotEnabled: reasonStr = "appleIntelligenceNotEnabled"
        case .modelNotReady: reasonStr = "modelNotReady"
        @unknown default: reasonStr = "unknown"
        }
        return ["type": "availability", "available": false, "reason": reasonStr]
    }
}

@available(macOS 26, *)
func runOneChat(_ req: ChatRequest, tasks: RunningTasks) async {
    do {
        // A fresh session per request: two concurrent calls on one
        // LanguageModelSession can crash the process; separate sessions are safe.
        let session = LanguageModelSession(
            instructions: req.instructions ?? "You are a concise, helpful assistant running locally on this Mac."
        )
        let options: GenerationOptions = req.maxTokens.map { GenerationOptions(maximumResponseTokens: $0) }
            ?? GenerationOptions()
        let stream = session.streamResponse(to: req.prompt, options: options)

        // streamResponse yields cumulative snapshots, not deltas: emit only the
        // suffix that is new since the last snapshot.
        var previous = ""
        for try await snapshot in stream {
            if Task.isCancelled { break }
            let full = snapshot.content
            if full.count > previous.count && full.hasPrefix(previous) {
                let delta = String(full.dropFirst(previous.count))
                if !delta.isEmpty { emitJSON(["type": "token", "id": req.id, "text": delta]) }
                previous = full
            } else if full != previous {
                // Defensive resync: the new snapshot didn't extend the
                // previous one as a prefix (not expected for String content,
                // but never emit a bogus negative-length diff) — emit the
                // whole current snapshot once instead of guessing at a delta.
                emitJSON(["type": "token", "id": req.id, "text": full])
                previous = full
            }
        }
        emitJSON(["type": "done", "id": req.id, "stopReason": Task.isCancelled ? "aborted" : "end_turn"])
    } catch is CancellationError {
        emitJSON(["type": "done", "id": req.id, "stopReason": "aborted"])
    } catch {
        emitJSON(["type": "error", "id": req.id, "message": "\(error)"])
    }
    await tasks.clear(req.id)
}

@available(macOS 26, *)
func runChatLoop() async {
    emitJSON(["type": "ready"])
    let (commands, cont) = AsyncStream<ChatCommand>.makeStream()
    startStdinLineReader(cont)
    let tasks = RunningTasks()
    for await cmd in commands {
        switch cmd {
        case .request(let req):
            if req.cancel {
                await tasks.cancel(req.id)
                continue
            }
            // Not awaited, so Snaglet sessions run concurrently instead of queueing.
            // AppleChatEngine (Node) serializes requests within one session.
            let task = Task { await runOneChat(req, tasks: tasks) }
            await tasks.set(req.id, task)
        case .malformed:
            err("[chat] failed to parse request line")
        case .eof:
            return
        }
    }
}

#endif

// Stub path (no FoundationModels, or macOS < 26): never fail the build or run;
// report "unavailable" so the Node resolver hides the provider.
func runAvailabilityStub() {
    emitJSON(["type": "availability", "available": false, "reason": "frameworkUnavailable"])
}

func runChatLoopStub() {
    emitJSON(["type": "ready"])
    let h = FileHandle.standardInput
    var buf = Data()
    while true {
        let chunk = h.availableData
        if chunk.isEmpty { return }
        buf.append(chunk)
        while let nl = buf.firstIndex(of: 0x0A) {
            let lineData = buf.subdata(in: buf.startIndex..<nl)
            buf.removeSubrange(buf.startIndex...nl)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if let req = parseRequest(trimmed), !req.cancel {
                emitJSON(["type": "error", "id": req.id, "message": "FoundationModels unavailable on this system"])
            }
        }
    }
}

// Main
let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
    err("usage: snaglet-apple-chat <availability|chat>")
    exit(2)
}

switch cmd {
case "availability":
    #if canImport(FoundationModels)
    if #available(macOS 26, *) {
        emitJSON(availabilityJSON())
        exit(0)
    }
    #endif
    runAvailabilityStub()
    exit(0)

case "chat":
    #if canImport(FoundationModels)
    if #available(macOS 26, *) {
        let sem = DispatchSemaphore(value: 0)
        Task {
            await runChatLoop()
            sem.signal()
        }
        sem.wait()
        exit(0)
    }
    #endif
    runChatLoopStub()
    exit(0)

default:
    err("unknown cmd \(cmd)")
    exit(2)
}
