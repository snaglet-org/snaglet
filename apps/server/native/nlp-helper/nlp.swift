import Foundation
import NaturalLanguage

// snaglet-nlp-helper: Snaglet's on-device entity and language extraction daemon. Apple's
// NaturalLanguage framework has no Node/C doorway, so Snaglet runs this binary over a
// pipe. It stays up for the server's lifetime (NlpHelperClient spawns and
// supervises it): spawning per call costs ~56 ms against ~4 ms warm.
// Wire protocol (README.md has the full spec):
//   stdin:  [u32 BE length][UTF-8 text] frames (text may contain newlines)
//   stdout: one JSON line per request, in request order, e.g.
//           {"entities":["Jane Doe","Acme Corp"],"language":"en"}
//   EOF on stdin exits 0.

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func emitJSON(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        // fflush, not FileHandle.synchronizeFile(), which throws or does nothing
        // on a pipe on Darwin: drain libc's buffer so Node sees each line now.
        fflush(stdout)
    }
}

/// Map an NLTag name-type tag to the clean lowercase string Snaglet persists.
func mapNameType(_ tag: NLTag) -> String? {
    switch tag {
    case .personalName: return "person"
    case .placeName: return "place"
    case .organizationName: return "org"
    default: return nil
    }
}

/// Extract deduplicated (person|place|org) entity strings via NLTagger. The
/// `.joinNames` option merges adjacent name tokens into one entity ("New York"
/// as a single place, not "New" + "York"). Case-insensitive de-dup keyed by
/// (kind, lowercased name) so "Paris" mentioned twice yields one entity, but
/// "Paris" the place and a person named "Paris" both survive.
func extractEntities(_ text: String) -> [String] {
    guard !text.isEmpty else { return [] }
    let tagger = NLTagger(tagSchemes: [.nameType])
    tagger.string = text
    var seen = Set<String>()
    var out: [String] = []
    let options: NLTagger.Options = [.omitWhitespace, .omitPunctuation, .joinNames]
    tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word,
                          scheme: .nameType, options: options) { tag, range in
        if let tag, let kind = mapNameType(tag) {
            let name = String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                let key = "\(kind):\(name.lowercased())"
                if !seen.contains(key) {
                    seen.insert(key)
                    out.append(name)
                }
            }
        }
        return true
    }
    return out
}

/// Detect the dominant language as a BCP-47 code (e.g. "en"), or nil when
/// NLLanguageRecognizer can't determine one (very short / ambiguous text).
func detectLanguage(_ text: String) -> String? {
    guard !text.isEmpty else { return nil }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    return recognizer.dominantLanguage?.rawValue
}

// stdin framing (host → helper)
// Blocking read of one length-prefixed frame: [4-byte BE uint32 length][text].
// Returns nil on EOF (stdin closed with no more bytes available), whether at a
// frame boundary or mid-frame — either way the daemon should just exit.
func readFrame(_ handle: FileHandle, _ buf: inout [UInt8]) -> Data? {
    while buf.count < 4 {
        let chunk = handle.availableData
        if chunk.isEmpty { return nil }
        buf.append(contentsOf: chunk)
    }
    let len = (Int(buf[0]) << 24) | (Int(buf[1]) << 16) | (Int(buf[2]) << 8) | Int(buf[3])
    while buf.count < 4 + len {
        let chunk = handle.availableData
        if chunk.isEmpty { return nil }
        buf.append(contentsOf: chunk)
    }
    let payload = Data(buf[4..<(4 + len)])
    buf.removeFirst(4 + len)
    return payload
}

// main loop
// One request at a time, synchronously — the Node wrapper serializes calls
// (see NlpHelperClient), so there is never more than one frame in flight and
// no request-id correlation is needed: request N's response is always the
// Nth line of stdout.
let stdinHandle = FileHandle.standardInput
var readBuf: [UInt8] = []
while let payload = readFrame(stdinHandle, &readBuf) {
    let text = String(data: payload, encoding: .utf8) ?? ""
    let entities = extractEntities(text)
    let language = detectLanguage(text)
    emitJSON(["entities": entities, "language": language ?? NSNull()])
}
