//! Moving the Snaglet home to another folder.
//!
//! The database can only be copied consistently while Snaglet's server is stopped,
//! so the shell splits the move in two: [`prepare`] runs while the server is
//! still up and rejects every destination problem it can detect (so the UI can
//! show the error and nothing stops), and [`execute`] copies into a sibling
//! staging folder, verifies every byte, and only then publishes it. The source
//! is never modified, which is what makes restarting on it the rollback.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Per-session files that belong to the running shell, not the home's data.
const SKIPPED_ENTRIES: [&str; 2] = ["data.lock", "desktop-cli-session.json"];
/// Finder metadata that may appear in a folder the user just picked.
const IGNORABLE_ENTRIES: [&str; 1] = [".DS_Store"];

fn is_skipped(name: &std::ffi::OsStr) -> bool {
    SKIPPED_ENTRIES.iter().any(|skipped| name == *skipped)
}

fn is_ignorable(name: &std::ffi::OsStr) -> bool {
    IGNORABLE_ENTRIES.iter().any(|ignored| name == *ignored)
}

#[derive(Debug)]
pub(crate) struct MovePlan {
    source: PathBuf,
    target: PathBuf,
    stage: PathBuf,
}

impl MovePlan {
    pub(crate) fn target(&self) -> &Path {
        &self.target
    }

    /// Remove the staging folder; the source and destination are untouched.
    pub(crate) fn discard(&self) {
        let _ = fs::remove_dir_all(&self.stage);
    }
}

/// Validate the destination and reserve a staging folder beside it. Runs
/// before the server stops, so every error here leaves Snaglet running as it was.
pub(crate) fn prepare(source: &Path, requested: &str) -> Result<MovePlan, String> {
    let target = validate_destination(source, requested)?;
    ensure_free_space(source, &target)?;
    let stage = stage_path(&target);
    if fs::symlink_metadata(&stage).is_ok() {
        return Err(format!(
            "{} is left over from an earlier move; remove it and try again",
            stage.display()
        ));
    }
    fs::create_dir_all(&stage)
        .map_err(|e| format!("cannot write to {}: {e}", display_parent(&target)))?;
    Ok(MovePlan {
        source: source.to_path_buf(),
        target,
        stage,
    })
}

/// Copy, verify and publish. Call only with the server stopped. On error the
/// staging folder is removed and the destination is left as it was found.
pub(crate) fn execute(plan: &MovePlan) -> Result<(), String> {
    let result = copy_home_tree(&plan.source, &plan.stage)
        .and_then(|()| verify_home_tree(&plan.source, &plan.stage))
        .and_then(|()| publish(&plan.stage, &plan.target));
    if result.is_err() {
        plan.discard();
    }
    result
}

fn display_parent(path: &Path) -> String {
    path.parent().unwrap_or(path).to_string_lossy().into_owned()
}

pub(crate) fn stage_path(target: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.snaglet-moving-{}",
        target.display(),
        std::process::id()
    ))
}

/// Resolve symlinks in the longest existing prefix of `path` so containment
/// checks compare real locations even when the final folder does not exist.
fn resolve_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    while fs::symlink_metadata(&existing).is_err() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name.to_owned());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut resolved = dunce::canonicalize(&existing)
        .map_err(|e| format!("cannot resolve {}: {e}", existing.display()))?;
    for name in missing.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

fn is_effectively_empty(dir: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot inspect destination: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot inspect destination: {e}"))?;
        if !is_ignorable(&entry.file_name()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `source` must be the canonical current Snaglet home.
pub(crate) fn validate_destination(source: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("Choose a folder to move Snaglet home into".into());
    }
    let raw = PathBuf::from(requested);
    if !raw.is_absolute() {
        return Err("Snaglet home destination must be absolute".into());
    }
    if raw
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Snaglet home destination must not contain '..'".into());
    }
    let target = resolve_existing_prefix(&raw)?;
    if target.parent().is_none() {
        return Err("Snaglet home cannot be moved to the root of a disk".into());
    }
    if target == source {
        return Err("That folder is already the current Snaglet home".into());
    }
    if target.starts_with(source) {
        return Err("Snaglet home cannot be moved into a folder inside itself".into());
    }
    if source.starts_with(&target) {
        return Err("Snaglet home cannot be moved into a folder that contains it".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) if !meta.is_dir() => {
            return Err(format!("{} is not a folder", target.display()));
        }
        Ok(_) if !is_effectively_empty(&target)? => {
            return Err("Snaglet home destination must be empty".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect destination: {error}")),
    }
    Ok(target)
}

/// Bytes of regular-file data a move will copy.
pub(crate) fn tree_size(dir: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot read Snaglet home: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot read Snaglet home entry: {e}"))?;
        if is_skipped(&entry.file_name()) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            // The live server may delete temporary files mid-walk.
            continue;
        };
        if meta.is_dir() {
            total = total.saturating_add(tree_size(&entry.path())?);
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

/// Room for the copy plus headroom for growth while the server keeps running
/// until the copy starts. The source is kept, so a same-disk move needs it too.
pub(crate) fn has_room(required: u64, available: u64) -> bool {
    let headroom = (required / 20).max(64 * 1024 * 1024);
    available >= required.saturating_add(headroom)
}

pub(crate) fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} bytes")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn nearest_existing(path: &Path) -> &Path {
    let mut current = path;
    while fs::symlink_metadata(current).is_err() {
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    current
}

#[cfg(target_os = "macos")]
fn available_space(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some(stat.f_bavail.saturating_mul(u64::from(stat.f_bsize)))
}

#[cfg(not(target_os = "macos"))]
fn available_space(_path: &Path) -> Option<u64> {
    None
}

fn ensure_free_space(source: &Path, target: &Path) -> Result<(), String> {
    let volume = nearest_existing(target);
    let Some(available) = available_space(volume) else {
        return Ok(());
    };
    let required = tree_size(source)?;
    if has_room(required, available) {
        Ok(())
    } else {
        Err(format!(
            "Not enough free space at {}: moving Snaglet home needs about {} but only {} is available",
            volume.display(),
            format_bytes(required),
            format_bytes(available)
        ))
    }
}

pub(crate) fn copy_home_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("cannot create destination: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("cannot read Snaglet home: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot read Snaglet home entry: {e}"))?;
        let name = entry.file_name();
        if is_skipped(&name) {
            continue;
        }
        let target = destination.join(&name);
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect entry: {e}"))?;
        if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(
                fs::read_link(entry.path()).map_err(|e| format!("cannot read symlink: {e}"))?,
                target,
            )
            .map_err(|e| format!("cannot copy symlink: {e}"))?;
        } else if kind.is_dir() {
            copy_home_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target).map_err(|e| format!("cannot copy Snaglet data: {e}"))?;
        }
        // Sockets and FIFOs (a stale PostgreSQL socket) carry no data.
    }
    Ok(())
}

pub(crate) fn verify_home_tree(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("cannot verify Snaglet home: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot verify Snaglet home entry: {e}"))?;
        let name = entry.file_name();
        if is_skipped(&name) {
            continue;
        }
        let source_path = entry.path();
        let target_path = destination.join(&name);
        let source_kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect source: {e}"))?;
        if !(source_kind.is_dir() || source_kind.is_symlink() || source_kind.is_file()) {
            continue;
        }
        let target_kind = fs::symlink_metadata(&target_path).map_err(|e| {
            format!(
                "moved Snaglet home is incomplete at {}: {e}",
                target_path.display()
            )
        })?;
        if source_kind.is_dir() {
            if !target_kind.is_dir() {
                return Err(format!(
                    "moved Snaglet home type mismatch at {}",
                    target_path.display()
                ));
            }
            verify_home_tree(&source_path, &target_path)?;
        } else if source_kind.is_symlink() {
            if !target_kind.file_type().is_symlink()
                || fs::read_link(&source_path).ok() != fs::read_link(&target_path).ok()
            {
                return Err(format!(
                    "moved Snaglet home symlink mismatch at {}",
                    target_path.display()
                ));
            }
        } else {
            let source_bytes = fs::read(&source_path)
                .map_err(|e| format!("cannot hash {}: {e}", source_path.display()))?;
            let target_bytes = fs::read(&target_path)
                .map_err(|e| format!("cannot hash {}: {e}", target_path.display()))?;
            if Sha256::digest(&source_bytes) != Sha256::digest(&target_bytes) {
                return Err(format!(
                    "moved Snaglet home checksum mismatch at {}",
                    target_path.display()
                ));
            }
        }
    }
    Ok(())
}

/// Swap the verified stage into place. The destination was checked empty in
/// `prepare`; anything that appeared since is left alone and fails the move.
fn publish(stage: &Path, target: &Path) -> Result<(), String> {
    if fs::symlink_metadata(target).is_ok() {
        if !is_effectively_empty(target)? {
            return Err(format!(
                "{} is no longer empty; nothing was moved",
                target.display()
            ));
        }
        for ignorable in IGNORABLE_ENTRIES {
            let _ = fs::remove_file(target.join(ignorable));
        }
        fs::remove_dir(target).map_err(|e| format!("cannot prepare destination: {e}"))?;
    }
    fs::rename(stage, target).map_err(|e| format!("cannot publish moved Snaglet home: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("snaglet-home-move-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).expect("create scratch dir");
            Self(dunce::canonicalize(&dir).expect("canonical scratch dir"))
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seeded_home(scratch: &Scratch) -> PathBuf {
        let home = scratch.path("home");
        fs::create_dir_all(home.join("postgres/base")).expect("create home tree");
        fs::write(home.join("credential.key"), "k".repeat(64)).expect("write key");
        fs::write(home.join("postgres/base/1"), vec![7u8; 4096]).expect("write table file");
        fs::write(home.join("data.lock"), "1").expect("write lock");
        fs::create_dir_all(home.join("runtime")).expect("create runtime");
        fs::write(home.join("runtime/desktop-cli-session.json"), "{}").expect("write session");
        home
    }

    #[test]
    fn destination_must_be_absolute_empty_and_outside_the_home() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);

        assert!(validate_destination(&home, "  ").is_err());
        assert!(validate_destination(&home, "relative/home").is_err());
        assert!(validate_destination(&home, &home.to_string_lossy()).is_err());
        let nested = home.join("nested");
        assert!(validate_destination(&home, &nested.to_string_lossy()).is_err());
        assert!(validate_destination(&home, &scratch.0.to_string_lossy()).is_err());
        let dotted = format!("{}/other/../escape", scratch.0.display());
        assert!(validate_destination(&home, &dotted).is_err());

        let occupied = scratch.path("occupied");
        fs::create_dir_all(&occupied).expect("create occupied");
        fs::write(occupied.join("notes.txt"), "keep").expect("write occupied");
        assert!(validate_destination(&home, &occupied.to_string_lossy()).is_err());

        let file = scratch.path("file");
        fs::write(&file, "x").expect("write file");
        assert!(validate_destination(&home, &file.to_string_lossy()).is_err());

        let picked = scratch.path("picked");
        fs::create_dir_all(&picked).expect("create picked");
        fs::write(picked.join(".DS_Store"), "").expect("write finder metadata");
        assert_eq!(
            validate_destination(&home, &picked.to_string_lossy()).expect("empty enough"),
            picked
        );
        let fresh = scratch.path("new/deeper/home");
        assert_eq!(
            validate_destination(&home, &fresh.to_string_lossy()).expect("missing is fine"),
            fresh
        );
    }

    #[cfg(unix)]
    #[test]
    fn destination_inside_the_home_through_a_symlink_is_rejected() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        let link = scratch.path("link-to-home");
        std::os::unix::fs::symlink(&home, &link).expect("create symlink");
        let sneaky = link.join("inside");
        assert!(validate_destination(&home, &sneaky.to_string_lossy()).is_err());
    }

    #[test]
    fn a_move_copies_verifies_and_publishes_without_touching_the_source() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        let picked = scratch.path("picked");
        fs::create_dir_all(&picked).expect("create picked");
        fs::write(picked.join(".DS_Store"), "").expect("write finder metadata");

        let plan = prepare(&home, &picked.to_string_lossy()).expect("prepare move");
        assert!(plan.stage.is_dir());
        execute(&plan).expect("execute move");

        assert!(!plan.stage.exists());
        assert_eq!(
            fs::read(picked.join("postgres/base/1")).expect("moved table file"),
            vec![7u8; 4096]
        );
        assert!(!picked.join("data.lock").exists());
        assert!(!picked.join("runtime/desktop-cli-session.json").exists());
        assert!(!picked.join(".DS_Store").exists());
        assert!(home.join("postgres/base/1").exists());
        assert!(home.join("data.lock").exists());
    }

    #[test]
    fn a_failed_publish_removes_the_stage_and_keeps_new_destination_files() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        let picked = scratch.path("picked");
        fs::create_dir_all(&picked).expect("create picked");

        let plan = prepare(&home, &picked.to_string_lossy()).expect("prepare move");
        fs::write(picked.join("arrived-later.txt"), "user data").expect("write late file");
        assert!(execute(&plan).is_err());

        assert!(!plan.stage.exists());
        assert_eq!(
            fs::read_to_string(picked.join("arrived-later.txt")).expect("late file kept"),
            "user data"
        );
        assert!(home.join("postgres/base/1").exists());
    }

    #[test]
    fn a_leftover_stage_is_never_deleted_by_a_new_attempt() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        let target = scratch.path("target");
        let stage = stage_path(&target);
        fs::create_dir_all(&stage).expect("create leftover stage");
        fs::write(stage.join("keep.txt"), "x").expect("write leftover");

        assert!(prepare(&home, &target.to_string_lossy()).is_err());
        assert!(stage.join("keep.txt").exists());
    }

    #[test]
    fn verification_catches_a_corrupted_copy() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        let copy = scratch.path("copy");
        copy_home_tree(&home, &copy).expect("copy tree");
        verify_home_tree(&home, &copy).expect("verify clean copy");
        fs::write(copy.join("postgres/base/1"), vec![8u8; 4096]).expect("corrupt copy");
        assert!(verify_home_tree(&home, &copy).is_err());
    }

    #[test]
    fn free_space_check_needs_the_copy_plus_headroom() {
        let gib = 1024 * 1024 * 1024;
        assert!(has_room(10 * gib, 11 * gib));
        assert!(!has_room(10 * gib, 10 * gib));
        assert!(!has_room(0, 1024));
        assert!(has_room(0, 64 * 1024 * 1024));
        assert_eq!(format_bytes(512), "512 bytes");
        assert_eq!(format_bytes(3 * gib / 2), "1.5 GB");
    }

    #[test]
    fn tree_size_counts_only_home_data() {
        let scratch = Scratch::new();
        let home = seeded_home(&scratch);
        assert_eq!(tree_size(&home).expect("size"), 64 + 4096);
    }
}
