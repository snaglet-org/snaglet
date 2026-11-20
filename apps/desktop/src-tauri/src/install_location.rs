//! First-launch install-location guard (macOS).
//!
//! Snaglet ships as an unsigned, ad-hoc-signed bundle. Two launch locations produce
//! failures that look like "the app is broken" rather than "the app is in the
//! wrong place", so we detect both up front and say so in plain language:
//!
//! 1. **App Translocation.** A downloaded bundle carries `com.apple.quarantine`.
//!    When macOS launches such a bundle from outside `/Applications` it runs it
//!    from a randomized read-only mount in the per-user temporary folder,
//!    `.../AppTranslocation/<uuid>/d/Snaglet.app`. The app is then not where the
//!    user thinks it is, and the path changes every launch.
//! 2. **Running straight off the disk image.** The DMG mounts read-only, so the
//!    app "works" until the user ejects it, at which point it dies mid-session.
//!
//! In both cases the fix is the same and the user has to perform it, so the
//! guard refuses to continue and tells them exactly what to do. Detection is
//! read-only and runs before the sidecar starts, so a blocked launch never
//! creates or touches a Snaglet home.

use std::path::{Path, PathBuf};

/// Why a launch location is unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadLocation {
    /// macOS is running a randomized read-only copy (quarantine + not installed).
    Translocated,
    /// The bundle lives on a read-only volume, typically the mounted DMG.
    ReadOnlyVolume,
}

/// Classify a bundle path. Pure so it can be unit-tested without a real launch.
fn classify(exe: &Path, read_only: bool) -> Option<BadLocation> {
    if exe
        .components()
        .any(|c| c.as_os_str() == "AppTranslocation")
    {
        return Some(BadLocation::Translocated);
    }
    if read_only {
        return Some(BadLocation::ReadOnlyVolume);
    }
    None
}

/// True when the filesystem containing `path` is mounted read-only.
/// Returns false on any error: a guard that cannot prove a problem must not
/// block launch.
#[cfg(target_os = "macos")]
fn is_read_only_volume(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `statfs` only writes into `buf`, and `c_path` is a valid NUL-
    // terminated string that outlives the call.
    unsafe {
        let mut buf: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut buf) != 0 {
            return false;
        }
        buf.f_flags & (libc::MNT_RDONLY as u32) != 0
    }
}

#[cfg(not(target_os = "macos"))]
fn is_read_only_volume(_path: &Path) -> bool {
    false
}

/// The `.app` bundle directory for a running executable at
/// `Snaglet.app/Contents/MacOS/desktop`, or the executable's own directory when the
/// binary is not inside a bundle (`cargo run`, CI).
fn bundle_dir(exe: &Path) -> PathBuf {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or_else(|| exe.parent().unwrap_or(exe))
        .to_path_buf()
}

fn title(kind: BadLocation) -> &'static str {
    match kind {
        BadLocation::Translocated => "Move Snaglet to your Applications folder",
        BadLocation::ReadOnlyVolume => "Install Snaglet before opening it",
    }
}

fn description(kind: BadLocation, running_from: &Path) -> String {
    let steps = "1. Quit Snaglet.\n\
         2. Open the Snaglet disk image and drag Snaglet.app onto the Applications folder.\n\
         3. Eject the disk image, then open Snaglet from your Applications folder.";
    let cause = match kind {
        BadLocation::Translocated => {
            "Snaglet is running from a temporary read-only location that macOS created for it, \
             because Snaglet was opened from your Downloads folder or the disk image instead of \
             being installed. This copy is thrown away and its location changes every launch, \
             so Snaglet cannot reliably store your data."
        }
        BadLocation::ReadOnlyVolume => {
            "Snaglet is running directly from the disk image, which is read-only. Snaglet would stop \
             working the moment you eject it."
        }
    };
    format!(
        "{cause}\n\n{steps}\n\nRunning from:\n{}",
        running_from.display()
    )
}

/// Check where this bundle is running from. Returns `true` when the launch may
/// continue; returns `false` after showing a blocking explanation dialog.
pub fn verify_or_explain() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let bundle = bundle_dir(&exe);
    let Some(kind) = classify(&exe, is_read_only_volume(&bundle)) else {
        return true;
    };

    eprintln!(
        "[shell] refusing to start: {kind:?} bundle at {}",
        bundle.display()
    );
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(title(kind))
        .set_description(description(kind, &bundle))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_a_translocated_path() {
        let exe = PathBuf::from(
            "/private/tmp/AppTranslocation/0000-UUID/d/Snaglet.app/Contents/MacOS/desktop",
        );
        assert_eq!(classify(&exe, false), Some(BadLocation::Translocated));
    }

    #[test]
    fn flags_a_read_only_volume() {
        let exe = PathBuf::from("/Volumes/Snaglet v0.1.0/Snaglet.app/Contents/MacOS/desktop");
        assert_eq!(classify(&exe, true), Some(BadLocation::ReadOnlyVolume));
    }

    #[test]
    fn allows_a_normal_install() {
        let exe = PathBuf::from("/Applications/Snaglet.app/Contents/MacOS/desktop");
        assert_eq!(classify(&exe, false), None);
    }

    #[test]
    fn does_not_match_a_folder_merely_named_like_the_marker() {
        // Substring matching on the whole path would false-positive here.
        let exe =
            PathBuf::from("/Users/me/AppTranslocationNotes/Snaglet.app/Contents/MacOS/desktop");
        assert_eq!(classify(&exe, false), None);
    }

    #[test]
    fn finds_the_bundle_root_from_the_inner_binary() {
        let exe = PathBuf::from("/Applications/Snaglet.app/Contents/MacOS/desktop");
        assert_eq!(bundle_dir(&exe), PathBuf::from("/Applications/Snaglet.app"));
    }

    #[test]
    fn falls_back_to_the_parent_dir_outside_a_bundle() {
        let exe = PathBuf::from("/tmp/target/release/desktop");
        assert_eq!(bundle_dir(&exe), PathBuf::from("/tmp/target/release"));
    }
}
