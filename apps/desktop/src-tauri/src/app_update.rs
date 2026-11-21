//! In-place app updates: which builds may update themselves, whether the
//! installed bundle can be replaced, what is checked before an update is kept,
//! and what the user is told when an update does not happen.
//!
//! tauri-plugin-updater downloads the archive, checks its minisign signature
//! against the `pubkey` in tauri.conf.json, and on macOS unpacks it into a
//! temp dir, moves the running bundle aside and moves the new one into place.
//! `install_app_update` in main.rs runs it under the restart discipline and
//! [`install_guarded`] keeps a copy of the previous app until the new one is
//! proven launchable.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::install_location;

/// Bundle identifier of the released app, the only build that updates itself.
const PRODUCTION_IDENTIFIER: &str = "com.snaglet.app";

const MOVE_TO_APPLICATIONS: &str =
    "Move Snaglet to your Applications folder, open it from there, and try again.";

/// Progress messages are capped at one per whole percent, or one per this
/// many bytes when the download size is unknown.
const UNKNOWN_SIZE_STEP: u64 = 4 * 1024 * 1024;

/// Whole-request limit for reading latest.json.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// A download that receives nothing for this long fails instead of hanging.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateErrorKind {
    /// No release newer than the running one.
    UpToDate,
    /// GitHub could not be reached, or the download stalled.
    Offline,
    /// The download does not match the release signing key or its version.
    SignatureRejected,
    /// The installed bundle cannot be replaced where it is.
    NotWritable,
    /// No usable in-app update is published for this Mac right now.
    NotAvailable,
    /// This build does not update itself (development or preview).
    Unsupported,
    /// An update, restart or home move is already running.
    Busy,
    Failed,
}

/// Why an update did not happen, as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateError {
    pub kind: UpdateErrorKind,
    pub message: String,
}

impl UpdateError {
    fn new(kind: UpdateErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn up_to_date() -> Self {
        Self::new(UpdateErrorKind::UpToDate, "Snaglet is up to date.")
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorKind::Busy, message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorKind::Failed, message)
    }

    fn not_writable(cause: &str) -> Self {
        Self::new(
            UpdateErrorKind::NotWritable,
            format!("{cause} {MOVE_TO_APPLICATIONS}"),
        )
    }
}

/// Sent to the UI while an update runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateProgress {
    Checking,
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Installing {
        version: String,
    },
}

/// Decides which download progress updates are worth sending.
#[derive(Default)]
pub struct ProgressThrottle {
    sent: Option<u64>,
}

impl ProgressThrottle {
    pub fn should_send(&mut self, downloaded: u64, total: Option<u64>) -> bool {
        let step = match total {
            Some(total) if total > 0 => downloaded.saturating_mul(100) / total,
            _ => downloaded / UNKNOWN_SIZE_STEP,
        };
        if self.sent == Some(step) {
            return false;
        }
        self.sent = Some(step);
        true
    }
}

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Held while one update runs, so a second click cannot start a second download.
pub struct UpdateClaim(());

impl UpdateClaim {
    pub fn take() -> Result<Self, UpdateError> {
        UPDATE_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| UpdateClaim(()))
            .map_err(|_| UpdateError::busy("Snaglet is already downloading this update."))
    }
}

impl Drop for UpdateClaim {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::SeqCst);
    }
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Marks the stop-and-swap stretch, during which quitting would leave the app
/// half replaced.
pub fn set_installing(on: bool) {
    INSTALLING.store(on, Ordering::SeqCst);
}

pub fn installing() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}

/// Block (up to `limit`) until the swap is finished. For quit paths that cannot
/// be cancelled, such as Quit from the app menu.
pub fn wait_while_installing(limit: Duration) {
    let deadline = Instant::now() + limit;
    while installing() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Why this build must not replace itself with a release, if it must not. A
/// development run's "bundle" is its target folder, and a preview build would
/// turn into the production app.
pub fn refusal(
    debug_build: bool,
    build_profile: Option<&str>,
    identifier: &str,
) -> Option<UpdateError> {
    if debug_build {
        return Some(UpdateError::new(
            UpdateErrorKind::Unsupported,
            "Development runs don't install updates.",
        ));
    }
    if build_profile == Some("desktop-preview") || identifier != PRODUCTION_IDENTIFIER {
        return Some(UpdateError::new(
            UpdateErrorKind::Unsupported,
            "Snaglet Preview doesn't install updates.",
        ));
    }
    None
}

/// The `.app` bundle the running executable is in, by the rule the updater
/// and Tauri's restart both use: `<bundle>.app/Contents/MacOS/<exe>`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Why the bundle at `exe` cannot be swapped in place. The updater renames
/// the running bundle into the temp folder, so it must sit on a writable
/// volume, and the same one as the temp folder.
pub fn location_problem(
    exe: &Path,
    read_only: bool,
    same_volume_as_temp: bool,
) -> Option<UpdateError> {
    if install_location::classify(exe, read_only).is_some() {
        return Some(UpdateError::not_writable(
            "Snaglet is running from a read-only location, such as its disk image.",
        ));
    }
    if !same_volume_as_temp {
        return Some(UpdateError::not_writable(
            "Snaglet can only replace itself on your startup disk.",
        ));
    }
    None
}

/// Why this account cannot replace the bundle itself. The updater only asks
/// for an administrator password (and then runs a shell command as root built
/// from these paths) when a plain rename is refused, so that case is refused
/// here instead, before anything is downloaded or stopped.
pub fn replace_problem(
    bundle: &Path,
    exists: bool,
    parent_writable: bool,
    bundle_writable: bool,
) -> Option<UpdateError> {
    if !exists {
        return Some(UpdateError::failed(format!(
            "Snaglet can't find its app at {}. Quit Snaglet, open it again, and try again.",
            bundle.display()
        )));
    }
    if bundle.to_string_lossy().contains(['\'', '"', '\\']) {
        return Some(UpdateError::not_writable(
            "Snaglet can't update itself in a folder whose path contains ', \" or \\.",
        ));
    }
    if !parent_writable || !bundle_writable {
        let folder = bundle.parent().unwrap_or(bundle);
        return Some(UpdateError::new(
            UpdateErrorKind::NotWritable,
            format!(
                "Your macOS account can't replace apps in {}. Download the update from the \
                 release page instead.",
                folder.display()
            ),
        ));
    }
    None
}

/// The running bundle, once it is known to be replaceable in place.
pub fn installed_bundle() -> Result<PathBuf, UpdateError> {
    let exe = std::env::current_exe()
        .map_err(|e| UpdateError::failed(format!("Snaglet could not locate its own app: {e}")))?;
    let Some(bundle) = bundle_of(&exe) else {
        return Err(UpdateError::new(
            UpdateErrorKind::Unsupported,
            "Snaglet is not running from an installed app, so it cannot update itself.",
        ));
    };
    if let Some(problem) = location_problem(
        &exe,
        install_location::is_read_only_volume(&bundle),
        same_volume(&bundle, &std::env::temp_dir()),
    ) {
        return Err(problem);
    }
    let parent = bundle.parent().unwrap_or(&bundle);
    match replace_problem(
        &bundle,
        bundle.symlink_metadata().is_ok(),
        writable(parent),
        writable(&bundle),
    ) {
        Some(problem) => Err(problem),
        None => Ok(bundle),
    }
}

/// True unless both paths exist on provably different volumes: a guard that
/// cannot prove a problem must not block the update.
#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => true,
    }
}

#[cfg(not(unix))]
fn same_volume(_a: &Path, _b: &Path) -> bool {
    true
}

#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(_path: &Path) -> bool {
    true
}

/// The user-facing reason for an updater failure.
pub fn describe(error: &tauri_plugin_updater::Error) -> UpdateError {
    use std::io::ErrorKind as Io;
    use tauri_plugin_updater::Error as E;
    use UpdateErrorKind::{NotAvailable, NotWritable, Offline, SignatureRejected};
    const UNREADABLE: &str = "The update information on GitHub isn't valid, so Snaglet can't \
                              install it from inside the app. Download it from the release page.";
    match error {
        E::Reqwest(e) if e.is_timeout() => UpdateError::new(
            Offline,
            "The update download stopped making progress. Check your internet connection and \
             try again.",
        ),
        E::Reqwest(e) if e.is_decode() => UpdateError::new(NotAvailable, UNREADABLE),
        E::Reqwest(e) if e.is_connect() || e.is_request() || e.is_body() => UpdateError::new(
            Offline,
            "Snaglet couldn't reach GitHub to get the update. Check your internet connection and \
             try again.",
        ),
        E::Reqwest(e) => UpdateError::failed(format!("The update could not be downloaded: {e}")),
        E::Network(detail) => UpdateError::failed(format!("The update download failed: {detail}.")),
        // The plugin reports any non-success answer for latest.json this way:
        // a release without update files, a rate limit, or a GitHub outage.
        E::ReleaseNotFound => UpdateError::new(
            NotAvailable,
            "Snaglet couldn't get the update information from GitHub. The release may not offer \
             an in-app update, or GitHub may be busy. Try again later, or download it from the \
             release page.",
        ),
        E::TargetNotFound(_) | E::TargetsNotFound(_) => UpdateError::new(
            NotAvailable,
            "The latest Snaglet release has no in-app update for this Mac. Download it from the \
             release page.",
        ),
        E::Serialization(_) | E::Semver(_) | E::UrlParse(_) => {
            UpdateError::new(NotAvailable, UNREADABLE)
        }
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => UpdateError::new(
            SignatureRejected,
            "The downloaded update failed its signature check, so Snaglet did not install it.",
        ),
        E::Io(io) if io.kind() == Io::PermissionDenied => UpdateError::new(
            NotWritable,
            "macOS did not let Snaglet replace itself. Download the update from the release page \
             instead.",
        ),
        E::Io(io) if matches!(io.kind(), Io::ReadOnlyFilesystem | Io::CrossesDevices) => {
            UpdateError::not_writable("Snaglet can't replace itself where it is installed.")
        }
        other => UpdateError::failed(format!("The update could not be installed: {other}")),
    }
}

/// The archive name scripts/release/updater.mjs gives a release.
pub fn archive_name(version: &str) -> String {
    format!("Snaglet-v{version}-macos-arm64.app.tar.gz")
}

/// The file name `tauri signer sign` recorded in the signature's trusted
/// comment (`timestamp:…\tfile:<name>`), decoded as the plugin decodes it.
pub fn signed_file_name(signature: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let trusted = text
        .lines()
        .find_map(|line| line.strip_prefix("trusted comment: "))?;
    trusted
        .split('\t')
        .find_map(|part| part.strip_prefix("file:"))
        .map(str::to_string)
}

/// The plugin authenticates the trusted comment but not which version it
/// names; refuse an archive signed as another version, so an older signed
/// archive cannot be served under a higher version number.
pub fn check_signed_version(signature: &str, version: &str) -> Result<(), UpdateError> {
    if signed_file_name(signature).as_deref() == Some(archive_name(version).as_str()) {
        return Ok(());
    }
    Err(UpdateError::new(
        UpdateErrorKind::SignatureRejected,
        format!(
            "The downloaded update is not signed as Snaglet {version}, so Snaglet did not \
             install it."
        ),
    ))
}

/// Why the bundle at `bundle` would not launch, or None. The quick form checks
/// that Info.plist names an executable that exists and can run; with
/// `check_signature` it also requires `codesign --verify --deep --strict`.
pub fn launch_problem(bundle: &Path, check_signature: bool) -> Option<String> {
    let info = match plist::Value::from_file(bundle.join("Contents/Info.plist")) {
        Ok(info) => info,
        Err(error) => return Some(format!("its Info.plist could not be read ({error})")),
    };
    let name = info
        .as_dictionary()
        .and_then(|info| info.get("CFBundleExecutable"))
        .and_then(plist::Value::as_string)
        .filter(|name| !name.is_empty() && !name.contains('/'));
    let Some(name) = name else {
        return Some("its Info.plist names no executable".into());
    };
    if !is_executable_file(&bundle.join("Contents/MacOS").join(name)) {
        return Some(format!("its executable {name} is missing or cannot run"));
    }
    if check_signature {
        if let Some(problem) = signature_problem(bundle) {
            return Some(problem);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(target_os = "macos")]
fn signature_problem(bundle: &Path) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .output();
    match output {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(format!(
            "its code signature is not valid ({})",
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .last()
                .unwrap_or("codesign failed")
                .trim()
        )),
        Err(error) => Some(format!("its code signature could not be checked ({error})")),
    }
}

#[cfg(not(target_os = "macos"))]
fn signature_problem(_bundle: &Path) -> Option<String> {
    None
}

/// `Snaglet (previous version).app`, then `… (previous version 2).app`, beside
/// the bundle. On the bundle's volume, so it can be an APFS clone, and outside
/// the temp folder, which macOS cleans.
pub fn previous_version_path(bundle: &Path, n: u32) -> PathBuf {
    let stem = bundle
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Snaglet".into());
    let name = if n <= 1 {
        format!("{stem} (previous version).app")
    } else {
        format!("{stem} (previous version {n}).app")
    };
    bundle.with_file_name(name)
}

/// A copy-on-write clone of the installed bundle, kept until the new version
/// is proven launchable.
///
/// The updater moves the running bundle into a temp dir that it deletes when
/// `install` returns, so without this copy a failed swap, or a new version that
/// cannot launch, would leave no working app. The clone costs no disk space.
pub struct SafetyCopy {
    bundle: PathBuf,
    copy: PathBuf,
    /// Set when the copy could not be put back, so it stays on disk.
    keep: bool,
    /// Set once the copy is back at the bundle path.
    restored: bool,
}

impl SafetyCopy {
    /// Best effort: None when no clone can be made (the update still runs).
    #[cfg(target_os = "macos")]
    pub fn take(bundle: &Path) -> Option<Self> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let copy = (1..=9)
            .map(|n| previous_version_path(bundle, n))
            .find(|path| path.symlink_metadata().is_err())?;
        let src = CString::new(bundle.as_os_str().as_bytes()).ok()?;
        let dst = CString::new(copy.as_os_str().as_bytes()).ok()?;
        // SAFETY: both are valid NUL-terminated paths that outlive the call.
        if unsafe { libc::clonefile(src.as_ptr(), dst.as_ptr(), 0) } != 0 {
            eprintln!(
                "[shell] could not clone {} before updating: {}",
                bundle.display(),
                std::io::Error::last_os_error()
            );
            return None;
        }
        Some(SafetyCopy {
            bundle: bundle.to_path_buf(),
            copy,
            keep: false,
            restored: false,
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn take(_bundle: &Path) -> Option<Self> {
        None
    }

    pub fn location(&self) -> &Path {
        &self.copy
    }

    /// Put the previous app back at the bundle path, moving whatever is there
    /// aside first. On failure nothing is deleted and the copy is kept.
    pub fn restore(&mut self) -> Result<(), String> {
        let name = self
            .bundle
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let aside = self
            .bundle
            .with_file_name(format!(".{name}.rejected-{}", uuid::Uuid::new_v4()));
        let moved_aside = self.bundle.symlink_metadata().is_ok();
        if moved_aside {
            if let Err(error) = std::fs::rename(&self.bundle, &aside) {
                self.keep = true;
                return Err(format!("could not move the new version aside: {error}"));
            }
        }
        match std::fs::rename(&self.copy, &self.bundle) {
            Ok(()) => {
                self.restored = true;
                if moved_aside {
                    let _ = std::fs::remove_dir_all(&aside);
                }
                Ok(())
            }
            Err(error) => {
                self.keep = true;
                if moved_aside {
                    let _ = std::fs::rename(&aside, &self.bundle);
                }
                Err(format!("could not put the previous version back: {error}"))
            }
        }
    }
}

impl Drop for SafetyCopy {
    /// Deletes the copy only when it is no longer needed: never when it could
    /// not be restored, and never when nothing is at the bundle path (as when
    /// unwinding from a panic mid-install).
    fn drop(&mut self) {
        if self.restored {
            return;
        }
        if self.keep || self.bundle.symlink_metadata().is_err() {
            eprintln!(
                "[shell] keeping the previous app at {}",
                self.copy.display()
            );
            return;
        }
        let _ = std::fs::remove_dir_all(&self.copy);
    }
}

/// What is left at the bundle path after an install that did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviousApp {
    /// A launchable app (the previous version) is in place.
    InPlace,
    /// No launchable app is in place; the previous version is kept here.
    KeptAt(PathBuf),
    /// No launchable app is in place and no copy exists.
    Lost,
}

#[derive(Debug)]
pub struct InstallFailure {
    pub error: UpdateError,
    pub previous: PreviousApp,
}

/// What is at the bundle path when there is no copy to fall back on.
pub fn previous_app(bundle: &Path) -> PreviousApp {
    if launch_problem(bundle, false).is_none() {
        PreviousApp::InPlace
    } else {
        PreviousApp::Lost
    }
}

/// Run `install`, then keep the result only if `check_new` finds the new
/// bundle launchable. Otherwise the previous app goes back in place from
/// `copy`; with no copy, what is in place is read from the filesystem.
pub fn install_guarded(
    bundle: &Path,
    mut copy: Option<SafetyCopy>,
    install: impl FnOnce() -> Result<(), UpdateError>,
    check_new: impl FnOnce(&Path) -> Option<String>,
) -> Result<(), InstallFailure> {
    let (error, replaced) = match install() {
        Ok(()) => match check_new(bundle) {
            None => return Ok(()),
            Some(problem) => (
                UpdateError::failed(format!(
                    "The new version failed its launch check: {problem}."
                )),
                true,
            ),
        },
        Err(error) => (error, false),
    };
    // A failed install usually leaves the previous app untouched; restore only
    // the rejected new version or a bundle that cannot launch.
    if !replaced && launch_problem(bundle, false).is_none() {
        return Err(InstallFailure {
            error,
            previous: PreviousApp::InPlace,
        });
    }
    let previous = match copy.as_mut() {
        Some(copy) => match copy.restore() {
            Ok(()) => PreviousApp::InPlace,
            Err(reason) => {
                eprintln!("[shell] {reason}");
                PreviousApp::KeptAt(copy.location().to_path_buf())
            }
        },
        None => PreviousApp::Lost,
    };
    Err(InstallFailure { error, previous })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_released_build_updates_itself() {
        let refused = |debug, profile, id| refusal(debug, profile, id).map(|e| e.kind);
        assert_eq!(
            refused(true, Some("desktop-production"), PRODUCTION_IDENTIFIER),
            Some(UpdateErrorKind::Unsupported)
        );
        assert_eq!(
            refused(false, Some("desktop-preview"), PRODUCTION_IDENTIFIER),
            Some(UpdateErrorKind::Unsupported)
        );
        assert_eq!(
            refused(false, Some("desktop-production"), "com.snaglet.app.preview"),
            Some(UpdateErrorKind::Unsupported)
        );
        assert_eq!(
            refused(false, Some("desktop-production"), PRODUCTION_IDENTIFIER),
            None
        );
        assert_eq!(refused(false, None, PRODUCTION_IDENTIFIER), None);
        let preview = refusal(false, Some("desktop-preview"), "com.snaglet.app.preview").unwrap();
        assert!(preview
            .message
            .contains("Snaglet Preview doesn't install updates"));
    }

    #[test]
    fn finds_the_bundle_only_for_an_executable_inside_one() {
        assert_eq!(
            bundle_of(Path::new(
                "/Applications/Snaglet.app/Contents/MacOS/desktop"
            )),
            Some(PathBuf::from("/Applications/Snaglet.app"))
        );
        assert_eq!(bundle_of(Path::new("/repo/target/release/desktop")), None);
        assert_eq!(
            bundle_of(Path::new("/Applications/Snaglet.app/Contents/desktop")),
            None
        );
        assert_eq!(
            bundle_of(Path::new("/x/Snaglet/Contents/MacOS/desktop")),
            None
        );
    }

    #[test]
    fn a_read_only_or_foreign_volume_cannot_be_updated_in_place() {
        let installed = Path::new("/Applications/Snaglet.app/Contents/MacOS/desktop");
        assert_eq!(location_problem(installed, false, true), None);

        let dmg = Path::new("/Volumes/Snaglet v1.0.0/Snaglet.app/Contents/MacOS/desktop");
        let problem = location_problem(dmg, true, false).unwrap();
        assert_eq!(problem.kind, UpdateErrorKind::NotWritable);
        assert!(problem.message.contains("read-only"));
        assert!(problem.message.contains("Applications folder"));

        let translocated = Path::new(
            "/private/var/folders/x/AppTranslocation/ID/d/Snaglet.app/Contents/MacOS/desktop",
        );
        assert_eq!(
            location_problem(translocated, false, true).map(|e| e.kind),
            Some(UpdateErrorKind::NotWritable)
        );

        let external = Path::new("/Volumes/Work/Snaglet.app/Contents/MacOS/desktop");
        let problem = location_problem(external, false, false).unwrap();
        assert!(problem.message.contains("startup disk"));
    }

    #[test]
    fn a_bundle_this_account_cannot_replace_is_refused_before_anything_runs() {
        let bundle = Path::new("/Applications/Snaglet.app");
        assert_eq!(replace_problem(bundle, true, true, true), None);

        let missing = replace_problem(bundle, false, true, true).unwrap();
        assert_eq!(missing.kind, UpdateErrorKind::Failed);
        assert!(missing.message.contains("can't find its app"));

        for (parent, own) in [(false, true), (true, false), (false, false)] {
            let problem = replace_problem(bundle, true, parent, own).unwrap();
            assert_eq!(problem.kind, UpdateErrorKind::NotWritable);
            assert!(problem
                .message
                .contains("can't replace apps in /Applications"));
        }

        for path in [
            "/Users/o'neil/Applications/Snaglet.app",
            "/Volumes/A \"B\"/Snaglet.app",
            "/Applications/back\\slash/Snaglet.app",
        ] {
            let problem = replace_problem(Path::new(path), true, true, true).unwrap();
            assert_eq!(problem.kind, UpdateErrorKind::NotWritable, "{path}");
        }
    }

    #[test]
    fn updater_errors_become_distinct_reasons() {
        use std::io::{Error as IoError, ErrorKind as Io};
        use tauri_plugin_updater::Error as E;
        let kind = |error: E| describe(&error).kind;

        let not_found = describe(&E::ReleaseNotFound);
        assert_eq!(not_found.kind, UpdateErrorKind::NotAvailable);
        // Also covers a rate limit or an outage, so it must not claim the
        // release cannot be installed.
        assert!(not_found
            .message
            .contains("couldn't get the update information"));
        assert_eq!(
            kind(E::TargetsNotFound(vec!["darwin-aarch64".into()])),
            UpdateErrorKind::NotAvailable
        );
        let invalid = serde_json::from_str::<u8>("not json").unwrap_err();
        let invalid = describe(&E::Serialization(invalid));
        assert_eq!(invalid.kind, UpdateErrorKind::NotAvailable);
        assert!(invalid.message.contains("isn't valid"));
        assert_eq!(
            kind(E::SignatureUtf8("bad".into())),
            UpdateErrorKind::SignatureRejected
        );
        assert_eq!(
            kind(E::Io(IoError::new(Io::PermissionDenied, "denied"))),
            UpdateErrorKind::NotWritable
        );
        assert_eq!(
            kind(E::Io(IoError::new(Io::ReadOnlyFilesystem, "ro"))),
            UpdateErrorKind::NotWritable
        );
        assert_eq!(
            kind(E::Io(IoError::new(Io::CrossesDevices, "xdev"))),
            UpdateErrorKind::NotWritable
        );
        assert_eq!(
            kind(E::Io(IoError::new(Io::StorageFull, "full"))),
            UpdateErrorKind::Failed
        );
        let network = describe(&E::Network(
            "Download request failed with status: 404 Not Found".into(),
        ));
        assert_eq!(network.kind, UpdateErrorKind::Failed);
        assert!(network.message.contains("404 Not Found"));
        assert_eq!(UpdateError::up_to_date().kind, UpdateErrorKind::UpToDate);
    }

    fn minisign_text(trusted_comment: &str) -> String {
        use base64::Engine;
        let text = format!(
            "untrusted comment: signature from tauri secret key\nRUQ=\ntrusted comment: \
             {trusted_comment}\nAA==\n"
        );
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn an_archive_signed_as_another_version_is_refused() {
        let signature =
            minisign_text("timestamp:1795220820\tfile:Snaglet-v1.0.1-macos-arm64.app.tar.gz");
        assert_eq!(
            signed_file_name(&signature).as_deref(),
            Some("Snaglet-v1.0.1-macos-arm64.app.tar.gz")
        );
        assert_eq!(check_signed_version(&signature, "1.0.1"), Ok(()));
        let older = check_signed_version(&signature, "1.0.2").unwrap_err();
        assert_eq!(older.kind, UpdateErrorKind::SignatureRejected);
        assert!(older.message.contains("not signed as Snaglet 1.0.2"));

        // The same fixture the release tests verify: signed as payload.txt.
        let fixture = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSTnpIWHdBb0FsWXV2aFZ2TXlQcnY3bHpNdGM5b21lSXA4MDRFc0lDRjl6dHdZOWxaRGJ6akZjWXc0NWxCcy9WWXNKaWd4TTFzMjRTRUFYdHM5eHhEZTkzRUQzY3Q0elE4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MjIwODIwCWZpbGU6cGF5bG9hZC50eHQKbmoxM3M0ZDZWVHBuUTUrTzJmSHJuZzlFYzdjcnArdTRuVkNNTG9yckVRMFM0b0t5bUhRSlhBZ3h6MVVPVVNUZ1QvRUgrQ3dzSzlCZVc0OGNDQ0NDQnc9PQo=";
        assert_eq!(signed_file_name(fixture).as_deref(), Some("payload.txt"));
        assert!(check_signed_version(fixture, "1.0.1").is_err());
        assert_eq!(signed_file_name("not base64!"), None);
        assert_eq!(signed_file_name(&minisign_text("timestamp:1")), None);
    }

    #[test]
    fn errors_and_progress_serialize_as_the_ui_reads_them() {
        let error = serde_json::to_value(UpdateError::up_to_date()).unwrap();
        assert_eq!(
            error,
            serde_json::json!({ "kind": "upToDate", "message": "Snaglet is up to date." })
        );
        let progress = serde_json::to_value(UpdateProgress::Downloading {
            version: "1.0.1".into(),
            downloaded: 5,
            total: Some(10),
        })
        .unwrap();
        assert_eq!(
            progress,
            serde_json::json!({ "phase": "downloading", "version": "1.0.1", "downloaded": 5, "total": 10 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Checking).unwrap(),
            serde_json::json!({ "phase": "checking" })
        );
    }

    #[test]
    fn progress_is_sent_once_per_percent() {
        let mut throttle = ProgressThrottle::default();
        let total = Some(1000);
        assert!(throttle.should_send(0, total));
        assert!(!throttle.should_send(5, total));
        assert!(throttle.should_send(10, total));
        assert!(!throttle.should_send(19, total));
        assert!(throttle.should_send(1000, total));

        let mut unknown = ProgressThrottle::default();
        assert!(unknown.should_send(1, None));
        assert!(!unknown.should_send(UNKNOWN_SIZE_STEP - 1, None));
        assert!(unknown.should_send(UNKNOWN_SIZE_STEP, None));
    }

    #[test]
    fn a_second_update_is_refused_while_one_runs() {
        let first = UpdateClaim::take().expect("first claim");
        assert_eq!(
            UpdateClaim::take().err().map(|e| e.kind),
            Some(UpdateErrorKind::Busy)
        );
        drop(first);
        assert!(UpdateClaim::take().is_ok());
    }

    #[test]
    fn quitting_waits_for_a_running_swap() {
        set_installing(true);
        let finisher = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(150));
            set_installing(false);
        });
        let started = Instant::now();
        wait_while_installing(Duration::from_secs(5));
        assert!(started.elapsed() >= Duration::from_millis(100));
        assert!(!installing());
        finisher.join().unwrap();
    }

    #[test]
    fn previous_versions_are_kept_beside_the_bundle() {
        let bundle = Path::new("/Applications/Snaglet.app");
        assert_eq!(
            previous_version_path(bundle, 1),
            PathBuf::from("/Applications/Snaglet (previous version).app")
        );
        assert_eq!(
            previous_version_path(bundle, 3),
            PathBuf::from("/Applications/Snaglet (previous version 3).app")
        );
    }

    #[cfg(target_os = "macos")]
    mod on_disk {
        use super::super::*;

        struct TempRoot(PathBuf);

        impl TempRoot {
            fn new() -> Self {
                let root = std::env::temp_dir()
                    .join(format!("snaglet-update-test-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&root).unwrap();
                Self(root)
            }
        }

        impl Drop for TempRoot {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        /// A minimal launchable bundle whose Resources/version.txt holds `version`.
        fn make_bundle(path: &Path, version: &str) {
            std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
            std::fs::create_dir_all(path.join("Contents/Resources")).unwrap();
            std::fs::write(
                path.join("Contents/Info.plist"),
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                 <key>CFBundleExecutable</key><string>app</string>\
                 <key>CFBundleIdentifier</key><string>com.example.update-test</string>\
                 </dict></plist>\n",
            )
            .unwrap();
            std::fs::copy("/usr/bin/true", path.join("Contents/MacOS/app")).unwrap();
            std::fs::write(path.join("Contents/Resources/version.txt"), version).unwrap();
        }

        fn version_at(bundle: &Path) -> String {
            std::fs::read_to_string(bundle.join("Contents/Resources/version.txt")).unwrap()
        }

        fn sign(bundle: &Path) {
            let status = std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(bundle)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "ad-hoc signing a test bundle");
        }

        fn chmod(path: &Path, mode: u32) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        }

        #[test]
        fn the_launch_check_needs_a_runnable_executable_and_a_valid_signature() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "new");
            sign(&bundle);
            assert_eq!(launch_problem(&bundle, false), None);
            assert_eq!(launch_problem(&bundle, true), None);

            // A sealed resource changed after signing: runnable, but not valid.
            std::fs::write(bundle.join("Contents/Resources/version.txt"), "tampered").unwrap();
            assert_eq!(launch_problem(&bundle, false), None);
            assert!(launch_problem(&bundle, true)
                .unwrap()
                .contains("code signature"));

            chmod(&bundle.join("Contents/MacOS/app"), 0o644);
            assert!(launch_problem(&bundle, false)
                .unwrap()
                .contains("cannot run"));
            std::fs::remove_file(bundle.join("Contents/MacOS/app")).unwrap();
            assert!(launch_problem(&bundle, false).unwrap().contains("missing"));
            std::fs::remove_file(bundle.join("Contents/Info.plist")).unwrap();
            assert!(launch_problem(&bundle, false)
                .unwrap()
                .contains("Info.plist"));
        }

        #[test]
        fn the_copy_sits_beside_the_bundle_and_goes_away_once_not_needed() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            // A leftover from an earlier attempt takes the first name.
            std::fs::create_dir(previous_version_path(&bundle, 1)).unwrap();

            let copy = SafetyCopy::take(&bundle).expect("APFS clone");
            assert_eq!(copy.location(), previous_version_path(&bundle, 2));
            assert_eq!(version_at(copy.location()), "old");
            let location = copy.location().to_path_buf();
            drop(copy);
            assert!(!location.exists());
        }

        #[test]
        fn the_copy_is_never_deleted_while_no_app_is_in_place() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let copy = SafetyCopy::take(&bundle).expect("APFS clone");
            let location = copy.location().to_path_buf();
            // As when a panic unwinds after the updater moved the app away.
            std::fs::remove_dir_all(&bundle).unwrap();
            drop(copy);
            assert_eq!(version_at(&location), "old");
        }

        #[test]
        fn restore_replaces_a_partial_bundle() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let mut copy = SafetyCopy::take(&bundle).expect("APFS clone");
            std::fs::remove_file(bundle.join("Contents/MacOS/app")).unwrap();
            std::fs::write(bundle.join("Contents/Resources/version.txt"), "partial").unwrap();

            copy.restore().unwrap();
            assert_eq!(version_at(&bundle), "old");
            assert_eq!(launch_problem(&bundle, false), None);
            let leftovers: Vec<_> = std::fs::read_dir(&root.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(leftovers, vec![std::ffi::OsString::from("Snaglet.app")]);
        }

        /// Stands in for the plugin: replace the bundle with `version`, or
        /// remove it and fail, or fail leaving it untouched.
        enum Plugin {
            Installs(&'static str),
            FailsAfterMovingAway,
            FailsUntouched,
        }

        fn run(
            bundle: &Path,
            copy: Option<SafetyCopy>,
            plugin: Plugin,
            new_ok: bool,
        ) -> Result<(), InstallFailure> {
            install_guarded(
                bundle,
                copy,
                || match plugin {
                    Plugin::Installs(version) => {
                        std::fs::remove_dir_all(bundle).unwrap();
                        make_bundle(bundle, version);
                        Ok(())
                    }
                    Plugin::FailsAfterMovingAway => {
                        std::fs::remove_dir_all(bundle).unwrap();
                        Err(UpdateError::failed("rename failed"))
                    }
                    Plugin::FailsUntouched => Err(UpdateError::failed("extract failed")),
                },
                |_| (!new_ok).then(|| "its code signature is not valid".to_string()),
            )
        }

        #[test]
        fn a_launchable_update_is_kept_and_the_copy_removed() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let copy = SafetyCopy::take(&bundle);
            assert!(run(&bundle, copy, Plugin::Installs("new"), true).is_ok());
            assert_eq!(version_at(&bundle), "new");
            assert!(!previous_version_path(&bundle, 1).exists());
        }

        #[test]
        fn an_update_that_fails_its_launch_check_is_rolled_back() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let copy = SafetyCopy::take(&bundle);
            let failure = run(&bundle, copy, Plugin::Installs("new"), false).unwrap_err();
            assert_eq!(failure.previous, PreviousApp::InPlace);
            assert!(failure.error.message.contains("launch check"));
            assert_eq!(version_at(&bundle), "old");
            assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
        }

        #[test]
        fn a_failed_swap_puts_the_previous_app_back() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");

            let copy = SafetyCopy::take(&bundle);
            let failure = run(&bundle, copy, Plugin::FailsAfterMovingAway, true).unwrap_err();
            assert_eq!(failure.previous, PreviousApp::InPlace);
            assert_eq!(version_at(&bundle), "old");

            let copy = SafetyCopy::take(&bundle);
            let failure = run(&bundle, copy, Plugin::FailsUntouched, true).unwrap_err();
            assert_eq!(failure.previous, PreviousApp::InPlace);
            assert_eq!(failure.error.message, "extract failed");
            assert!(!previous_version_path(&bundle, 1).exists());
        }

        #[test]
        fn without_a_copy_what_is_in_place_is_read_from_disk() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let failure = run(&bundle, None, Plugin::FailsUntouched, true).unwrap_err();
            assert_eq!(failure.previous, PreviousApp::InPlace);
            assert_eq!(previous_app(&bundle), PreviousApp::InPlace);

            let failure = run(&bundle, None, Plugin::FailsAfterMovingAway, true).unwrap_err();
            assert_eq!(failure.previous, PreviousApp::Lost);
            assert_eq!(previous_app(&bundle), PreviousApp::Lost);
        }

        #[test]
        fn a_copy_that_cannot_go_back_is_kept_and_named() {
            let root = TempRoot::new();
            let bundle = root.0.join("Snaglet.app");
            make_bundle(&bundle, "old");
            let copy = SafetyCopy::take(&bundle).expect("APFS clone");
            let location = copy.location().to_path_buf();
            let failure = install_guarded(
                &bundle,
                Some(copy),
                || {
                    std::fs::remove_dir_all(&bundle).unwrap();
                    // The folder stops accepting changes, so the copy cannot
                    // be renamed back into place.
                    chmod(&root.0, 0o555);
                    Err(UpdateError::failed("rename failed"))
                },
                |_| None,
            );
            chmod(&root.0, 0o755);
            let failure = failure.unwrap_err();
            assert_eq!(failure.previous, PreviousApp::KeptAt(location.clone()));
            assert_eq!(version_at(&location), "old");
        }
    }
}
