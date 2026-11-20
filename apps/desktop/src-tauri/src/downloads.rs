//! Saving bytes the page already holds (a database snapshot) to a file the
//! user picks in the native save dialog.
//!
//! WKWebView has no save dialog of its own: wry hands a `download`-attribute
//! link to its default download handler, which drops the file into
//! ~/Downloads without asking and without reporting whether it worked. The
//! page therefore sends the bytes here instead. It supplies only the bytes and
//! a suggested name; the destination always comes from the dialog, so the page
//! cannot write anywhere the user did not choose.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Percent-encoded suggested file name (header values must be ASCII).
pub(crate) const FILE_NAME_HEADER: &str = "x-snaglet-file-name";
/// Percent-encoded dialog title.
pub(crate) const TITLE_HEADER: &str = "x-snaglet-dialog-title";

pub(crate) fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| format!("malformed percent-encoding in {value:?}"))?;
            decoded.push(hex);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| format!("{value:?} does not decode to UTF-8"))
}

/// The name only pre-fills the dialog, but keep it a bare file name.
pub(crate) fn suggested_file_name(raw: &str) -> String {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || name == "." || name == ".." {
        "download".to_string()
    } else {
        name.to_string()
    }
}

fn partial_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    path.with_file_name(format!(".{name}.snaglet-partial-{}", std::process::id()))
}

/// Write beside the destination, then rename over it, so an interrupted save
/// never leaves a truncated file under the chosen name. Replacing an existing
/// file is fine: the save dialog already asked.
pub(crate) fn write_file_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let partial = partial_path(path);
    let result = fs::File::create(&partial)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&partial, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(format!("cannot save {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding_round_trips_encode_uri_component() {
        assert_eq!(
            percent_decode("snaglet-snapshot%202026.dump").unwrap(),
            "snaglet-snapshot 2026.dump"
        );
        assert_eq!(percent_decode("caf%C3%A9.dump").unwrap(), "café.dump");
        assert_eq!(percent_decode("plain.dump").unwrap(), "plain.dump");
        assert!(percent_decode("bad%2").is_err());
        assert!(percent_decode("bad%zz").is_err());
        assert!(percent_decode("%FF").is_err());
    }

    #[test]
    fn suggested_names_are_bare_file_names() {
        assert_eq!(suggested_file_name("snapshot.dump"), "snapshot.dump");
        assert_eq!(suggested_file_name("../../etc/passwd"), "passwd");
        assert_eq!(suggested_file_name("C:\\Users\\x\\snap.dump"), "snap.dump");
        assert_eq!(suggested_file_name("  "), "download");
        assert_eq!(suggested_file_name("dir/"), "download");
        assert_eq!(suggested_file_name(".."), "download");
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_partial() {
        let dir =
            std::env::temp_dir().join(format!("snaglet-downloads-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create scratch dir");
        let target = dir.join("snapshot.dump");
        fs::write(&target, "old").expect("seed existing file");

        write_file_atomically(&target, b"PGDMP-new").expect("save");
        assert_eq!(fs::read(&target).expect("read saved"), b"PGDMP-new");
        assert_eq!(fs::read_dir(&dir).expect("list").count(), 1);

        let missing_dir = dir.join("missing").join("snapshot.dump");
        assert!(write_file_atomically(&missing_dir, b"x").is_err());
        assert_eq!(fs::read_dir(&dir).expect("list").count(), 1);
        fs::remove_dir_all(&dir).expect("remove scratch dir");
    }
}
