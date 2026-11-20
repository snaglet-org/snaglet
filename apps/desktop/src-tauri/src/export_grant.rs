//! Export overwrite grants — proof that a native save dialog selected a path.
//!
//! ## Why a signed grant and not a boolean
//!
//! Overwriting a user's file is the one irreversible thing this feature does,
//! so the server must only do it on evidence that the OS "replace?" prompt was
//! actually shown and answered. An `overwrite: true` field carries no such
//! evidence: the export endpoint is reachable from the webview, from a browser
//! on the dev server, and from anything holding a session — all of which can
//! set a boolean. "The dialog already asked" is a claim the server cannot
//! check, and an unverifiable claim is not authorization.
//!
//! ## Why not the existing sidecar tokens
//!
//! `token` and `panel_token` are injected into the page via
//! `window.__SNAGLET_DESKTOP__` (main.rs initialization_script). Anything the
//! webview can read, a compromised or merely buggy page can replay — so they
//! prove "a webview asked", not "a native dialog ran". This key is generated
//! here, handed to the sidecar through its environment, and **never** reaches
//! JavaScript or the CLI session descriptor.
//!
//! ## What the grant binds
//!
//! An HMAC-SHA256 over `v1|<expiry_ms>|<nonce>|<len>|<canonical path>`. The
//! path is length-prefixed so a filename containing `|` cannot shift the
//! fields. The path is not transmitted in the token: the server recomputes the
//! MAC using the target it is *about to write*, so a grant for one file can
//! never authorize another. The token is `<expiry_ms>.<nonce>.<hex mac>`.
//!
//! Expiry is deliberately short and the nonce is single-use server-side, so a
//! captured grant is not a standing license to clobber that path.

use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a grant stays valid. A save dialog is answered and submitted in
/// seconds; anything longer is a replay window for no benefit.
const GRANT_TTL_MS: u128 = 120_000;

const HMAC_BLOCK: usize = 64;

/// HMAC-SHA256 (RFC 2104), built on the `sha2` crate already vendored for
/// drop-path recovery rather than adding a dependency. Pinned against RFC 4231
/// test vectors below, because a hand-rolled MAC that is subtly wrong would
/// still "work" end to end while being trivially forgeable.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; HMAC_BLOCK];
    if key.len() > HMAC_BLOCK {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_key = [0u8; HMAC_BLOCK];
    let mut outer_key = [0u8; HMAC_BLOCK];
    for i in 0..HMAC_BLOCK {
        inner_key[i] = block[i] ^ 0x36;
        outer_key[i] = block[i] ^ 0x5c;
    }

    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The exact bytes both sides sign. Any divergence between this and the
/// server's `canonicalPayload` silently disables overwrite (fail-closed), so
/// they are kept deliberately trivial and are cross-checked by tests on both
/// sides using the same fixture.
pub fn canonical_payload(expiry_ms: u128, nonce: &str, canonical_path: &str) -> String {
    format!(
        "v1|{expiry_ms}|{nonce}|{}|{canonical_path}",
        canonical_path.as_bytes().len()
    )
}

/// A fresh 32-byte key, hex-encoded, for one app boot.
///
/// Built from two v4 UUIDs (each drawn from the OS CSPRNG via `getrandom`)
/// folded through SHA-256 — 244 bits of entropy into a 256-bit key, using only
/// crates already present.
pub fn generate_key() -> String {
    let mut hasher = Sha256::new();
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    to_hex(&hasher.finalize())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Canonicalize a picked save path so it matches what the server will resolve.
///
/// The FILE does not exist yet (or is about to be replaced), so only its
/// parent can be `canonicalize`d — which is also what the server does before
/// joining the filename. Without this, a user whose Desktop sits under a
/// symlink would sign one spelling and the server would compute another, and
/// overwrite would fail for a legitimate selection.
pub fn canonical_target(picked: &Path) -> Option<String> {
    let parent = picked.parent()?;
    let name = picked.file_name()?;
    let real_parent = std::fs::canonicalize(parent).ok()?;
    Some(real_parent.join(name).to_string_lossy().into_owned())
}

/// Mint a grant for `canonical_path`. Returns `None` when no key exists — dev
/// runs without the packaged sidecar simply get no overwrite authority, which
/// is the correct degradation rather than a fallback to trusting a boolean.
pub fn mint(key_hex: &str, canonical_path: &str) -> Option<String> {
    if key_hex.is_empty() {
        return None;
    }
    let expiry = now_ms() + GRANT_TTL_MS;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mac = hmac_sha256(
        key_hex.as_bytes(),
        canonical_payload(expiry, &nonce, canonical_path).as_bytes(),
    );
    Some(format!("{expiry}.{nonce}.{}", to_hex(&mac)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2. A hand-rolled HMAC has to be checked against the
    /// standard's own vectors — "it produces some bytes" is not evidence.
    #[test]
    fn hmac_matches_rfc4231_vector() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// RFC 4231 test case 1.
    #[test]
    fn hmac_matches_rfc4231_short_key_vector() {
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(
            to_hex(&mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    /// RFC 4231 test case 3 — key longer than the block, exercising the
    /// "hash the key first" branch.
    #[test]
    fn hmac_handles_key_longer_than_block() {
        let mac = hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            to_hex(&mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn payload_is_length_prefixed_so_a_pipe_cannot_shift_fields() {
        // Two different paths must never produce the same signed payload just
        // because one contains the field separator.
        let a = canonical_payload(1, "n", "/tmp/a|b");
        let b = canonical_payload(1, "n", "/tmp/a");
        assert_ne!(a, b);
        assert!(a.ends_with("|8|/tmp/a|b"));
    }

    #[test]
    fn keys_are_unique_per_call() {
        assert_ne!(generate_key(), generate_key());
        assert_eq!(generate_key().len(), 64);
    }

    #[test]
    fn mint_returns_none_without_a_key() {
        assert!(mint("", "/tmp/x.md").is_none());
    }

    #[test]
    fn minted_grants_have_three_parts_and_a_fresh_nonce() {
        let key = generate_key();
        let first = mint(&key, "/tmp/x.md").expect("grant");
        let second = mint(&key, "/tmp/x.md").expect("grant");
        assert_eq!(first.split('.').count(), 3);
        // A reused nonce would make the one-time server-side cache useless.
        assert_ne!(first, second);
    }

    #[test]
    fn different_paths_produce_different_macs() {
        let key = generate_key();
        let a = mint(&key, "/tmp/a.md").expect("grant");
        let b = mint(&key, "/tmp/b.md").expect("grant");
        let mac_a = a.split('.').nth(2).unwrap();
        let mac_b = b.split('.').nth(2).unwrap();
        assert_ne!(mac_a, mac_b);
    }
}
