#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_install;
mod downloads;
mod drop_path_recovery;
mod export_grant;
mod home_move;
mod install_location;
mod links;
mod notifications;
mod sidecar;
mod splash;
mod theme;
mod windows_acl;

use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// Status and links

#[derive(Serialize)]
struct SocketStatus {
    status: String,
    version: String,
    capabilities: Vec<String>,
}

#[tauri::command]
fn socket_status() -> SocketStatus {
    SocketStatus {
        status: "running".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        capabilities: vec!["shell".into(), "fs".into()],
    }
}

/// Open a web or mail link in the system default browser / mail client.
/// Other schemes (file:, custom app schemes) are refused: the page must not be
/// able to launch arbitrary local files or apps through the shell.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    links::open_external(&parsed)
}

// Folder Picker

/// Native folder picker. `title` says what the folder is for (project folder,
/// export destination, new Snaglet home) so the dialog never claims to pick a
/// "project folder" when it is choosing where Snaglet's data moves.
#[tauri::command]
fn pick_folder(title: Option<String>) -> Option<String> {
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Select Folder".to_string());
    FileDialog::new()
        .set_title(&title)
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

// Save-file Picker
//
// Sibling of `pick_folder`, for exports. Returns the full path the user chose,
// including the filename they typed — the caller splits it into the directory
// (which the server guards and must already exist) and the file name (which the
// server sanitizes). The server never receives a single file path, because a
// not-yet-created file has no realpath to resolve and therefore cannot be
// checked against Snaglet storage.
//
// `save_file()` also collects the overwrite decision: the native dialog asks
// "replace?" itself when the user picks an existing name. That answer is why
// the export API accepts an overwrite flag from a human at all.

/// What `pick_save_file` hands back to the UI.
///
/// `overwrite_grant` is the only thing that can authorize replacing an
/// existing file. It is minted here, after the native dialog has run and
/// therefore after the OS has asked "replace?" on the user's behalf, and it is
/// bound to the exact path chosen. It is absent in dev (no packaged sidecar,
/// so no key), which correctly leaves dev runs no-clobber.
#[derive(serde::Serialize)]
struct SaveFileSelection {
    path: String,
    #[serde(rename = "overwriteGrant")]
    overwrite_grant: Option<String>,
}

#[tauri::command]
fn pick_save_file(
    default_name: Option<String>,
    title: Option<String>,
) -> Option<SaveFileSelection> {
    let mut dialog = FileDialog::new().set_title(title.as_deref().unwrap_or("Export"));
    if let Some(name) = default_name.as_deref().filter(|n| !n.trim().is_empty()) {
        dialog = dialog.set_file_name(name);
    }
    let picked = dialog.save_file()?;

    // Sign the canonical spelling: the server resolves symlinks on the parent
    // before joining the filename, and a mismatch here would silently disable
    // overwrite for anyone whose folder sits under a link.
    let grant = export_grant::canonical_target(&picked).and_then(|canonical| {
        SIDECAR
            .get()
            .and_then(|state| export_grant::mint(&state.export_grant_key, &canonical))
    });

    Some(SaveFileSelection {
        path: picked.to_string_lossy().into_owned(),
        overwrite_grant: grant,
    })
}

/// Save bytes the page already holds (a snapshot download) to a file the user
/// picks in the native save dialog; see `downloads.rs`. Returns the saved
/// path, or `None` when the dialog is dismissed. Async so the write runs off
/// the main thread; rfd hands the dialog itself to the main thread.
#[tauri::command]
async fn save_download(request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_download expects the file's bytes as the request body".into());
    };
    let header = |name: &str| -> Result<Option<String>, String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(downloads::percent_decode)
            .transpose()
    };
    let file_name =
        downloads::suggested_file_name(&header(downloads::FILE_NAME_HEADER)?.unwrap_or_default());
    let title = header(downloads::TITLE_HEADER)?
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Save".to_string());
    let Some(path) = FileDialog::new()
        .set_title(&title)
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(None);
    };
    downloads::write_file_atomically(&path, bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// Dropped-file Path Recovery
//
// The webview's native drag-drop handler is disabled (see `.setup()` below),
// so a Finder drop only gives the client a browser `File` object with no real
// filesystem path (web-platform sandboxing). The client hashes the dropped
// bytes (sha256) and calls this command with the file's name/size/hash; we ask
// Spotlight (`mdfind`) for same-named files, then disambiguate by size and
// content hash. This is a thin wrapper around `drop_path_recovery.rs`, which
// holds the filtering logic and its tests.
#[tauri::command]
fn resolve_dropped_file_path(
    name: String,
    size: u64,
    content_hash: String,
    is_directory: Option<bool>,
) -> drop_path_recovery::DropPathResolution {
    drop_path_recovery::resolve(&name, size, &content_hash, is_directory.unwrap_or(false))
}

/// Only one restart / move may run at a time, and a crash prompt must not
/// appear while one is already taking Snaglet down.
static LIFECYCLE_BUSY: AtomicBool = AtomicBool::new(false);

fn claim_lifecycle() -> Result<(), String> {
    LIFECYCLE_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| ())
        .map_err(|_| "Snaglet is already restarting".to_string())
}

fn release_lifecycle() {
    LIFECYCLE_BUSY.store(false, Ordering::SeqCst);
}

/// Stop the sidecar (Node, then its PostgreSQL) and relaunch the app.
///
/// Blocks for as long as the graceful shutdown takes, so it must run off the
/// main thread. `AppHandle::restart()` on the main thread skips
/// `RunEvent::Exit`, which would leave the old server running against the
/// same data directory while the new instance boots; stopping explicitly and
/// then using `request_restart` avoids both problems.
fn restart_cleanly(app: &tauri::AppHandle) {
    if let Some(state) = SIDECAR.get() {
        sidecar::shutdown(state);
    }
    app.request_restart();
}

/// Restart the whole app. Used by Settings after the Snaglet home path changes:
/// `SNAGLET_HOME` is resolved once at process start (and injected into the sidecar),
/// so a relaunch is the only way the new path takes effect. We restart for the
/// user rather than asking them to quit-and-reopen manually.
#[tauri::command]
async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    claim_lifecycle()?;
    tauri::async_runtime::spawn_blocking(move || restart_cleanly(&app))
        .await
        .map_err(|e| {
            release_lifecycle();
            format!("restart failed: {e}")
        })
}

/// Check for + install an app update via the Tauri updater, then restart.
///
/// Dormant until the signing workflow publishes releases carrying updater
/// artifacts (`latest.json` + signed bundles) and tauri.conf.json gets a real
/// `pubkey`: until then `check()` fails fast and the UI falls back to opening
/// the GitHub release page. Kept async and error-stringed so the UI can show
/// the failure reason inline.
#[tauri::command]
async fn install_app_update(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    match update {
        Some(update) => {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| format!("download/install failed: {e}"))?;
            // restart() never returns; the Ok is for the type checker only.
            app.restart();
        }
        None => Err("already up to date".into()),
    }
}

/// Move the Snaglet home, then relaunch on it.
///
/// Destination problems are reported to the UI while Snaglet keeps running. Once
/// the server has been stopped for a consistent copy, every outcome ends in a
/// relaunch: onto the new home on success, or back onto the untouched current
/// home (after a native error dialog) if copying, verifying or publishing
/// fails. The source is retained either way.
#[tauri::command]
async fn move_snaglet_home(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = SIDECAR
        .get()
        .copied()
        .ok_or("Snaglet sidecar is not running")?;
    claim_lifecycle()?;
    tauri::async_runtime::spawn_blocking(move || move_home_blocking(&app, state, &path))
        .await
        .unwrap_or_else(|e| {
            release_lifecycle();
            Err(format!("moving Snaglet home failed: {e}"))
        })
}

fn move_home_blocking(
    app: &tauri::AppHandle,
    state: &'static sidecar::SidecarState,
    requested: &str,
) -> Result<(), String> {
    let source = sidecar::active_home(state);
    let plan = match home_move::prepare(&source, requested) {
        Ok(plan) => plan,
        Err(error) => {
            release_lifecycle();
            return Err(error);
        }
    };

    let outcome = if sidecar::shutdown(state) && sidecar::postgres_is_stopped(state) {
        home_move::execute(&plan).and_then(|()| {
            sidecar::write_home_pointer(plan.target()).map_err(|error| {
                format!(
                    "Snaglet copied your data to {} but could not switch to it: {error}",
                    plan.target().display()
                )
            })
        })
    } else {
        plan.discard();
        Err(
            "Snaglet's server did not stop cleanly, so its database could not be copied safely"
                .into(),
        )
    };
    if let Err(error) = &outcome {
        report_move_failure(&source, error);
    }
    app.request_restart();
    outcome
}

fn report_move_failure(source: &Path, error: &str) {
    MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title("Moving Snaglet home failed")
        .set_description(format!(
            "{error}\n\nSnaglet will restart and keep using its current home at {}, which was not changed.",
            source.display()
        ))
        .set_buttons(MessageButtons::Ok)
        .show();
}

/// Which of `labels` the user picked. rfd reports a custom button as
/// `Custom(label)` where the platform can show custom labels (macOS) and as
/// the stock Yes/No/Ok result where it falls back to stock buttons. `None`
/// means the dialog was dismissed.
pub(crate) fn dialog_choice(result: &MessageDialogResult, labels: &[&str]) -> Option<usize> {
    match result {
        MessageDialogResult::Custom(label) => labels.iter().position(|l| l == label),
        MessageDialogResult::Yes | MessageDialogResult::Ok => Some(0),
        MessageDialogResult::No => Some(1),
        MessageDialogResult::Cancel => None,
    }
}

const RESTART_LABEL: &str = "Restart Snaglet";
const QUIT_LABEL: &str = "Quit Snaglet";

fn last_lines(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    let mut start = tail.len().saturating_sub(max_bytes);
    while !tail.is_char_boundary(start) {
        start += 1;
    }
    tail[start..].to_string()
}

fn crash_description(payload: &sidecar::SidecarCrashPayload, logs_dir: &Path) -> String {
    let how = payload.exit_code.map_or_else(
        || "was terminated".to_string(),
        |code| format!("exited with code {code}"),
    );
    let mut text = format!(
        "Snaglet's background server {how}. Your data is saved on disk; restart Snaglet to continue.\n\nLogs: {}",
        logs_dir.display()
    );
    let tail = last_lines(&payload.log_tail, 12, 1500);
    if !tail.is_empty() {
        text.push_str("\n\n");
        text.push_str(&tail);
    }
    text
}

/// Runs on the crash-watch thread. The UI cannot see `sidecar-crashed` (the
/// page's remote origin has no event permission), so the shell asks natively.
fn on_sidecar_crash(app: &tauri::AppHandle, payload: sidecar::SidecarCrashPayload) {
    if claim_lifecycle().is_err() {
        return;
    }
    let logs_dir = SIDECAR
        .get()
        .map(|state| sidecar::logs_dir(state).to_path_buf())
        .unwrap_or_default();
    let choice = MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title("Snaglet stopped unexpectedly")
        .set_description(crash_description(&payload, &logs_dir))
        .set_buttons(MessageButtons::OkCancelCustom(
            RESTART_LABEL.into(),
            QUIT_LABEL.into(),
        ))
        .show();
    match dialog_choice(&choice, &[RESTART_LABEL, QUIT_LABEL]) {
        Some(0) => restart_cleanly(app),
        _ => app.exit(0),
    }
}

fn recover_unavailable_home(error: &str) -> bool {
    const RETRY: &str = "Retry";
    const LOCATE: &str = "Locate";
    const USE_DEFAULT: &str = "Use Default";
    let choice = MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title("Snaglet home is unavailable")
        .set_description(format!(
            "{error}\n\nReconnect it and Retry, Locate an existing Snaglet home, or explicitly Use Default."
        ))
        .set_buttons(MessageButtons::YesNoCancelCustom(
            RETRY.into(),
            LOCATE.into(),
            USE_DEFAULT.into(),
        ))
        .show();
    // macOS reports every custom button as `Custom(label)`, so match labels:
    // treating any `Custom` as "Use Default" would turn Retry into a silent
    // switch to an empty default home.
    match dialog_choice(&choice, &[RETRY, LOCATE, USE_DEFAULT]) {
        Some(0) => true,
        Some(1) => FileDialog::new()
            .set_title("Locate Snaglet home")
            .pick_folder()
            .is_some_and(|folder| sidecar::write_home_pointer(&folder).is_ok()),
        Some(2) => sidecar::clear_home_pointer().is_ok(),
        _ => false,
    }
}

fn is_unavailable_home_error(error: &str) -> bool {
    (error.starts_with("configured SNAGLET_HOME ") || error.starts_with("saved Snaglet home "))
        && error.contains(" is unavailable or not writable")
}

#[cfg(test)]
mod startup_error_tests {
    use super::{crash_description, dialog_choice, is_unavailable_home_error, last_lines};
    use crate::sidecar::SidecarCrashPayload;
    use rfd::MessageDialogResult;
    use std::path::Path;

    #[test]
    fn dialog_choice_maps_custom_labels_and_stock_fallbacks() {
        let labels = ["Retry", "Locate", "Use Default"];
        let custom = |label: &str| MessageDialogResult::Custom(label.to_string());
        assert_eq!(dialog_choice(&custom("Retry"), &labels), Some(0));
        assert_eq!(dialog_choice(&custom("Locate"), &labels), Some(1));
        assert_eq!(dialog_choice(&custom("Use Default"), &labels), Some(2));
        assert_eq!(dialog_choice(&custom("Other"), &labels), None);
        assert_eq!(dialog_choice(&MessageDialogResult::Yes, &labels), Some(0));
        assert_eq!(dialog_choice(&MessageDialogResult::Ok, &labels), Some(0));
        assert_eq!(dialog_choice(&MessageDialogResult::No, &labels), Some(1));
        assert_eq!(dialog_choice(&MessageDialogResult::Cancel, &labels), None);
    }

    #[test]
    fn crash_description_names_the_exit_and_trims_the_log() {
        let log: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        let payload = SidecarCrashPayload {
            exit_code: Some(1),
            log_tail: log,
        };
        let text = crash_description(&payload, Path::new("/tmp/snaglet-test/logs"));
        assert!(text.contains("exited with code 1"));
        assert!(text.contains("Logs: /tmp/snaglet-test/logs"));
        assert!(text.contains("line 40"));
        assert!(!text.contains("line 28\n"));

        let signaled = SidecarCrashPayload {
            exit_code: None,
            log_tail: String::new(),
        };
        let text = crash_description(&signaled, Path::new("/tmp/snaglet-test/logs"));
        assert!(text.contains("was terminated"));
        assert!(text.ends_with("/tmp/snaglet-test/logs"));
    }

    #[test]
    fn last_lines_respects_line_and_byte_limits() {
        assert_eq!(last_lines("a\nb\nc\n", 2, 100), "b\nc");
        assert_eq!(last_lines("éééé", 5, 3), "é");
        assert_eq!(last_lines("", 3, 10), "");
    }

    #[test]
    fn only_unavailable_snaglet_home_errors_offer_home_recovery() {
        assert!(is_unavailable_home_error(
            "configured SNAGLET_HOME C:\\Snaglet is unavailable or not writable; reconnect it"
        ));
        assert!(is_unavailable_home_error(
            "saved Snaglet home C:\\Snaglet is unavailable or not writable; reconnect it"
        ));
        assert!(!is_unavailable_home_error(
            "packaged PostgreSQL executable missing: C:\\Snaglet\\pg\\bin\\initdb.exe"
        ));
        assert!(!is_unavailable_home_error(
            "failed to spawn sidecar node process: access denied"
        ));
    }
}

#[tauri::command]
fn cli_install_status(app: tauri::AppHandle) -> Result<cli_install::CliInstallStatus, String> {
    cli_install::status(&app)
}

#[tauri::command]
fn install_cli(app: tauri::AppHandle) -> Result<cli_install::CliInstallStatus, String> {
    cli_install::install(&app)
}

#[tauri::command]
fn uninstall_cli(app: tauri::AppHandle) -> Result<cli_install::CliInstallStatus, String> {
    cli_install::uninstall(&app)
}

// Main

/// Sidecar handle for shutdown wiring. `launch` leaks a 'static ref
/// deliberately — the sidecar lives for the whole app lifetime. Set as soon as
/// the child exists, so quitting during a long boot still stops it.
static SIDECAR: std::sync::OnceLock<&'static sidecar::SidecarState> = std::sync::OnceLock::new();

/// The app window. External links leave for the system browser and the
/// webview never navigates off `url`'s origin.
fn build_app_window(
    app: &tauri::AppHandle,
    url: tauri::Url,
    title: &str,
    init_script: Option<&str>,
) -> tauri::Result<tauri::WebviewWindow> {
    let navigation_origin = url.clone();
    let new_window_origin = url.clone();
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
            .title(title)
            .inner_size(1200.0, 800.0)
            // The default theme's canvas until the page paints, so the window
            // does not open white (window layer everywhere; on macOS also the
            // web view's under-page color).
            .background_color(theme::window_background())
            .on_navigation(move |target| links::handle_navigation(&navigation_origin, target))
            .on_new_window(move |target, _features| {
                links::handle_new_window(&new_window_origin, &target);
                tauri::webview::NewWindowResponse::Deny
            });
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }
    // WebKit's native handler intercepts HTML5 chip/pane drags, so keep it
    // disabled outside Windows. Windows leaves it enabled for the UI's native
    // external-file listener only.
    #[cfg(not(target_os = "windows"))]
    let builder = builder.disable_drag_drop_handler();
    builder.build()
}

fn fail_startup(app: &tauri::AppHandle, error: &str) {
    eprintln!("[shell] sidecar failed to start: {error}");
    MessageDialog::new()
        .set_level(MessageLevel::Error)
        .set_title("Snaglet failed to start")
        .set_description(error)
        .show();
    app.exit(1);
}

/// Boot the sidecar behind the splash window. Runs on its own thread: the
/// wait can legitimately take many minutes (a large-database upgrade), and the
/// main thread must keep the splash and dialogs responsive meanwhile.
fn boot_sidecar(
    app: tauri::AppHandle,
    server_dir: PathBuf,
    pg_root: PathBuf,
    rg_root: PathBuf,
    app_name: &'static str,
) {
    let state = match sidecar::launch(&app, &server_dir, &pg_root, &rg_root) {
        Ok(state) => state,
        Err(error) => return fail_startup(&app, &error),
    };
    let _ = SIDECAR.set(state);

    let mut progress = splash::SplashProgress::new(
        app.clone(),
        app_name,
        sidecar::logs_dir(state).to_path_buf(),
    );
    match sidecar::wait_until_ready(&app, state, &mut progress) {
        Ok(()) => {}
        // The app is already quitting; its exit path owns the shutdown.
        Err(sidecar::BootFailure::Canceled) => return,
        Err(sidecar::BootFailure::Declined) => return app.exit(0),
        Err(sidecar::BootFailure::Failed(error)) => return fail_startup(&app, &error),
    }

    // The `snaglet` launcher follows the app's bundled Node, CLI and Snaglet home, so
    // keep it installed and current. Best effort: a failure never blocks boot.
    match cli_install::ensure_installed(&app) {
        Ok(outcome) => eprintln!("[snaglet-desktop] cli auto-install: {outcome}"),
        Err(error) => eprintln!("[snaglet-desktop] cli auto-install failed: {error}"),
    }

    let crash_app = app.clone();
    sidecar::watch_for_crash(&app, state, move |payload| {
        on_sidecar_crash(&crash_app, payload)
    });

    let base = format!("http://127.0.0.1:{}", state.port);
    // apiBaseUrl carries the /api suffix: getApiUrl() in the UI appends route
    // paths directly, so the bare origin would send every request to the SPA
    // catch-all (HTTP 404).
    let init = format!(
        "window.__SNAGLET_DESKTOP__ = {{ apiBaseUrl: '{base}/api', appName: '{app_name}', token: '{}', panelToken: '{}' }};",
        state.token, state.panel_token
    );
    let url: tauri::Url = base.parse().expect("sidecar url");
    // Open the app window before closing the splash: closing the last window
    // would quit the app.
    match build_app_window(&app, url, app_name, Some(&init)) {
        Ok(_) => splash::close(&app),
        Err(error) => fail_startup(&app, &format!("cannot open the Snaglet window: {error}")),
    }
}

fn main() {
    let is_preview = option_env!("SNAGLET_BUILD_PROFILE") == Some("desktop-preview");
    let app_name: &'static str = if is_preview {
        "Snaglet Preview"
    } else {
        "Snaglet"
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        // Updater is dormant until a signed release with updater artifacts
        // exists: with no endpoint reachable / no signature, check() simply
        // errors and the UI falls back to opening the release page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // One desktop app per Snaglet home is a product choice even though external
        // PostgreSQL mode permits deliberate multi-process server sharing.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            let window = app
                .get_webview_window("main")
                .or_else(|| app.get_webview_window(splash::LABEL));
            if let Some(window) = window {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .register_uri_scheme_protocol(splash::SCHEME, move |_context, _request| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(splash::page(app_name))
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
        })
        .invoke_handler(tauri::generate_handler![
            socket_status,
            open_url,
            pick_folder,
            pick_save_file,
            restart_app,
            install_app_update,
            move_snaglet_home,
            resolve_dropped_file_path,
            save_download,
            cli_install_status,
            install_cli,
            uninstall_cli,
            notifications::notifications_status,
            notifications::notifications_request_permission,
            notifications::notifications_sync,
            notifications::notifications_cancel_all,
            notifications::notifications_take_clicked,
            notifications::notifications_show,
            notifications::notifications_close,
        ])
        .setup(move |app| {
            use tauri::Manager;
            let handle = app.handle().clone();

            // First, so a reminder click that launched Snaglet reaches its handler.
            notifications::init(&handle);

            if cfg!(debug_assertions) {
                // Dev: the vite dev server (beforeDevCommand) serves the UI and
                // the repo dev server provides the API — no sidecar.
                let url = app
                    .config()
                    .build
                    .dev_url
                    .clone()
                    .expect("Tauri build.devUrl must be configured in development");
                build_app_window(&handle, url, "Snaglet (dev)", None)?;
                return Ok(());
            }

            // A bundle the user never installed runs either from the read-only
            // disk image or from a randomized read-only App Translocation path.
            // Both end in an unexplained failure deeper in startup, so say what
            // is actually wrong while the message can still name the fix. This
            // runs before the sidecar, so a refused launch creates no Snaglet home.
            if !install_location::verify_or_explain() {
                std::process::exit(1);
            }

            // An unavailable saved home is resolved here, before any window,
            // with the same Retry / Locate / Use Default prompt as always. If
            // it is still unavailable, the boot thread reports it.
            if let Err(error) = sidecar::data_dir() {
                if is_unavailable_home_error(&error) {
                    recover_unavailable_home(&error);
                }
            }

            // Release: show the splash, then spawn the bundled server sidecar
            // off the main thread and open the app window at its loopback
            // origin once it is healthy, with the per-session config injected
            // before any page script runs.
            let resource_dir = handle.path().resource_dir().expect("resource dir");
            let server_dir = resource_dir.join("server");
            let pg_root = resource_dir.join("pg");
            let rg_root = resource_dir.join("rg");
            splash::open(&handle, app_name)?;
            std::thread::Builder::new()
                .name("snaglet-sidecar-boot".into())
                .spawn(move || boot_sidecar(handle, server_dir, pg_root, rg_root, app_name))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = SIDECAR.get() {
                    // Graceful: server drains, closes its pool, and stops owned
                    // PostgreSQL before the Rust fallback escalates. Releasing
                    // the home lock afterward keeps a relaunch from racing
                    // this process's exit for it.
                    if sidecar::shutdown(state) {
                        sidecar::release_home_lock(state);
                    }
                }
            }
        });
}
