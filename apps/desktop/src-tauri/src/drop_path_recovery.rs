//! drop_path_recovery — recover a dropped file's absolute path via Spotlight.
//!
//! On macOS `main.rs` disables Tauri's native drag-drop handler, because it and
//! WKWebView's HTML5 drag/drop (which chip drags and pane splitting need) are
//! mutually exclusive. So `onDragDropEvent` never fires, and the browser File
//! API never exposes a real path either.
//!
//! Instead the client hashes the dropped `File`'s bytes (sha256, Web Crypto)
//! and asks us to find a matching file on disk. We ask Spotlight (`mdfind`) for
//! every file with that name, then disambiguate by exact size and, if still
//! ambiguous, by content hash, never trusting the name alone.
//!
//! The OS-touching parts are thin wrappers; `resolve_from_candidates` is pure
//! and holds the decision logic, so it is unit-testable without `mdfind`.

use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::process::Command;

/// Cap on how many ambiguous candidates we'll ever hand back to the client —
/// a picker with more entries than this is a UX failure, not a feature.
const MAX_CANDIDATES: usize = 10;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DropPathResolution {
    Unique { path: String },
    Ambiguous { candidates: Vec<String> },
    NotFound,
}

/// One `mdfind` hit, with whatever we could determine about it from disk.
/// `hash` is `None` when we didn't bother computing it (size already ruled
/// the candidate out — see `candidate_info`) or couldn't read the file
/// (permissions, or something deleted it between indexing and lookup).
/// Either way that just means this candidate can't win a hash-disambiguation
/// round — it never crashes the lookup.
#[derive(Debug, Clone)]
pub struct CandidateInfo {
    pub path: String,
    pub size: u64,
    pub hash: Option<String>,
}

/// Pure decision logic: given every candidate `mdfind` found (with its real
/// on-disk size and, where computed, content hash), decide whether the
/// dropped file resolves to exactly one path, several, or none.
///
/// Kept free of any I/O so it can be exhaustively unit-tested — the actual
/// `mdfind`/fs-touching pipeline lives in `resolve` below and only ever
/// calls into this.
pub fn resolve_from_candidates(
    candidates: Vec<CandidateInfo>,
    expected_size: u64,
    expected_hash: &str,
) -> DropPathResolution {
    let size_matched: Vec<CandidateInfo> = candidates
        .into_iter()
        .filter(|c| c.size == expected_size)
        .collect();

    if size_matched.is_empty() {
        return DropPathResolution::NotFound;
    }
    if size_matched.len() == 1 {
        return DropPathResolution::Unique {
            path: size_matched[0].path.clone(),
        };
    }

    // Same size, multiple hits (duplicate files, or distinct files that
    // happen to share a size) — disambiguate by content hash.
    let hash_matched: Vec<&CandidateInfo> = size_matched
        .iter()
        .filter(|c| c.hash.as_deref() == Some(expected_hash))
        .collect();

    if hash_matched.len() == 1 {
        return DropPathResolution::Unique {
            path: hash_matched[0].path.clone(),
        };
    }

    // Either the hash narrowed it to >1 (real duplicates), or it narrowed it
    // to 0 (hash unavailable/mismatched for every same-size hit) — in the
    // latter case fall back to the size-matched set rather than silently
    // discarding candidates we can't fully verify.
    let pool: Vec<&CandidateInfo> = if hash_matched.is_empty() {
        size_matched.iter().collect()
    } else {
        hash_matched
    };

    DropPathResolution::Ambiguous {
        candidates: pool
            .into_iter()
            .take(MAX_CANDIDATES)
            .map(|c| c.path.clone())
            .collect(),
    }
}

/// Pure decision logic for a dropped *folder*. A directory has no meaningful
/// size or content hash to compare, so every `mdfind` hit that is still a
/// directory on disk is a contender: one is the answer, several go to the
/// picker (capped at `MAX_CANDIDATES`), none is "not found".
pub fn resolve_directory_from_candidates(dir_paths: Vec<String>) -> DropPathResolution {
    match dir_paths.len() {
        0 => DropPathResolution::NotFound,
        1 => DropPathResolution::Unique {
            path: dir_paths[0].clone(),
        },
        _ => DropPathResolution::Ambiguous {
            candidates: dir_paths.into_iter().take(MAX_CANDIDATES).collect(),
        },
    }
}

/// Escape a filename for embedding as a Spotlight metadata-query string
/// literal (`kMDItemFSName == "<escaped>"`). The whole query is passed as a
/// single `Command` argument (never through a shell — see `mdfind_paths`),
/// so this only needs to satisfy `mdfind`'s own query-language escaping,
/// not shell metacharacters, which can't reach a shell here at all.
fn escape_mdfind_literal(name: &str) -> String {
    name.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Ask Spotlight for every file named `name`, anywhere it's indexed. Thin on
/// purpose: all the actual decision-making happens in
/// `resolve_from_candidates`. Any failure here (binary missing, indexing
/// disabled, spawn error) yields an empty candidate list rather than
/// propagating an error, so a broken/missing `mdfind` degrades to
/// "not found" instead of crashing the app.
#[cfg(target_os = "macos")]
fn mdfind_paths(name: &str) -> Vec<String> {
    let query = format!("kMDItemFSName == \"{}\"", escape_mdfind_literal(name));
    let output = match Command::new("mdfind").arg(&query).output() {
        Ok(out) if out.status.success() => out,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Spotlight is macOS-only. Every other platform (Linux dev boxes, CI,
/// Windows) resolves to "not found" rather than attempting a lookup that
/// couldn't possibly succeed.
#[cfg(not(target_os = "macos"))]
fn mdfind_paths(_name: &str) -> Vec<String> {
    Vec::new()
}

fn hash_file_contents(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// Gather on-disk info for one `mdfind` hit. Returns `None` if the path no
/// longer exists / isn't readable (a race between indexing and lookup, or a
/// permissions issue) — such candidates are simply dropped rather than
/// crashing the lookup.
fn candidate_info(path: String, expected_size: u64) -> Option<CandidateInfo> {
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let size = metadata.len();
    // Only worth hashing full file contents once size already narrows this
    // down to a real contender — hashing every same-named file on disk
    // regardless of size would be wasted I/O for files that can't match.
    let hash = if size == expected_size {
        hash_file_contents(&path)
    } else {
        None
    };
    Some(CandidateInfo { path, size, hash })
}

/// Entry point called by the `resolve_dropped_file_path` Tauri command in
/// `main.rs`. Kept separate from the `#[tauri::command]` fn itself so the
/// OS-touching pipeline (mdfind -> stat -> hash) stays in one obvious place.
pub fn resolve(
    name: &str,
    size: u64,
    content_hash: &str,
    is_directory: bool,
) -> DropPathResolution {
    if is_directory {
        let dirs: Vec<String> = mdfind_paths(name)
            .into_iter()
            .filter(|path| std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false))
            .collect();
        return resolve_directory_from_candidates(dirs);
    }
    let candidates: Vec<CandidateInfo> = mdfind_paths(name)
        .into_iter()
        .filter_map(|path| candidate_info(path, size))
        .collect();
    resolve_from_candidates(candidates, size, content_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(path: &str, size: u64, hash: Option<&str>) -> CandidateInfo {
        CandidateInfo {
            path: path.to_string(),
            size,
            hash: hash.map(|h| h.to_string()),
        }
    }

    #[test]
    fn directory_with_no_candidates_is_not_found() {
        assert_eq!(
            resolve_directory_from_candidates(vec![]),
            DropPathResolution::NotFound
        );
    }

    #[test]
    fn directory_with_one_candidate_is_unique() {
        assert_eq!(
            resolve_directory_from_candidates(vec!["/Users/me/Projects/overlay-lab".into()]),
            DropPathResolution::Unique {
                path: "/Users/me/Projects/overlay-lab".into()
            }
        );
    }

    #[test]
    fn directory_with_several_candidates_is_ambiguous_and_capped() {
        let many: Vec<String> = (0..15).map(|i| format!("/d{i}/overlay-lab")).collect();
        match resolve_directory_from_candidates(many) {
            DropPathResolution::Ambiguous { candidates } => {
                assert_eq!(candidates.len(), MAX_CANDIDATES);
                assert_eq!(candidates[0], "/d0/overlay-lab");
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn empty_candidates_is_not_found() {
        assert_eq!(
            resolve_from_candidates(vec![], 100, "deadbeef"),
            DropPathResolution::NotFound
        );
    }

    #[test]
    fn no_size_match_is_not_found() {
        let candidates = vec![candidate("/a/file.txt", 50, Some("deadbeef"))];
        assert_eq!(
            resolve_from_candidates(candidates, 100, "deadbeef"),
            DropPathResolution::NotFound
        );
    }

    #[test]
    fn single_size_match_is_unique_without_needing_hash() {
        let candidates = vec![
            candidate("/a/file.txt", 50, None),
            candidate("/b/file.txt", 100, None),
        ];
        assert_eq!(
            resolve_from_candidates(candidates, 100, "deadbeef"),
            DropPathResolution::Unique {
                path: "/b/file.txt".to_string()
            }
        );
    }

    #[test]
    fn same_size_disambiguated_by_hash() {
        let candidates = vec![
            candidate("/a/file.txt", 100, Some("aaaa")),
            candidate("/b/file.txt", 100, Some("deadbeef")),
        ];
        assert_eq!(
            resolve_from_candidates(candidates, 100, "deadbeef"),
            DropPathResolution::Unique {
                path: "/b/file.txt".to_string()
            }
        );
    }

    #[test]
    fn same_size_same_hash_is_ambiguous() {
        let candidates = vec![
            candidate("/a/file.txt", 100, Some("deadbeef")),
            candidate("/b/file.txt", 100, Some("deadbeef")),
        ];
        assert_eq!(
            resolve_from_candidates(candidates, 100, "deadbeef"),
            DropPathResolution::Ambiguous {
                candidates: vec!["/a/file.txt".to_string(), "/b/file.txt".to_string()]
            }
        );
    }

    #[test]
    fn same_size_unreadable_hashes_falls_back_to_size_matched_ambiguous() {
        // Neither candidate's hash could be computed (e.g. unreadable) — we
        // can't disambiguate further, so report both rather than silently
        // picking one.
        let candidates = vec![
            candidate("/a/file.txt", 100, None),
            candidate("/b/file.txt", 100, None),
        ];
        assert_eq!(
            resolve_from_candidates(candidates, 100, "deadbeef"),
            DropPathResolution::Ambiguous {
                candidates: vec!["/a/file.txt".to_string(), "/b/file.txt".to_string()]
            }
        );
    }

    #[test]
    fn ambiguous_list_is_capped_at_ten() {
        let candidates: Vec<CandidateInfo> = (0..15)
            .map(|i| candidate(&format!("/dup/file{i}.txt"), 100, Some("deadbeef")))
            .collect();
        match resolve_from_candidates(candidates, 100, "deadbeef") {
            DropPathResolution::Ambiguous { candidates } => {
                assert_eq!(candidates.len(), MAX_CANDIDATES)
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn escapes_backslash_and_quote_in_query_literal() {
        assert_eq!(
            escape_mdfind_literal("weird\"name.txt"),
            "weird\\\"name.txt"
        );
        assert_eq!(escape_mdfind_literal(r"back\slash.txt"), r"back\\slash.txt");
    }
}
