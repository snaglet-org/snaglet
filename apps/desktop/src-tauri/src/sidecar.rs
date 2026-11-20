//! Sidecar lifecycle — spawn, guard, and shut down the bundled Node server.
//!
//! Responsibilities:
//!   - data-dir resolution (`~/.snaglet`, overridable via SNAGLET_HOME)
//!   - product-level lockfile with PID + staleness check (one desktop app per
//!     Snaglet home; external PostgreSQL still permits deliberate server sharing)
//!   - random free loopback port + per-session auth token (never a fixed
//!     port, never unauthenticated)
//!   - per-install credential-encryption key (~/.snaglet/credential.key) so the
//!     server's required CREDENTIAL_ENCRYPTION_KEY exists without user setup
//!   - spawn `node server.mjs` from the app Resources with stdout/stderr
//!     captured in ~/.snaglet/logs/sidecar.console.log (fresh per launch, trimmed
//!     while running); the server's own logger writes ~/.snaglet/logs/server.log
//!   - health-poll /health until ready, waiting as long as the server is alive
//!     and still producing output (a large-database upgrade can take minutes)
//!   - crash watch: hand the shell a log excerpt so it can offer Restart / Quit
//!     instead of leaving a dead window
//!   - graceful shutdown: SIGTERM, bounded server drain, then exact PostgreSQL
//!     immediate-stop fallback after any SIGKILL escalation

use crate::windows_acl::protect_secret_file_handle;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Seek, SeekFrom, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::Emitter;

const SHUTDOWN_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const SIDECAR_EXIT_TIMEOUT: Duration = Duration::from_secs(35);
const POSTGRES_STOP_TIMEOUT_SECS: &str = "20";

/// How long boot may go without any new server output before the shell asks
/// whether to keep waiting. Never a reason to kill the server on its own: a
/// pre-migration dump plus migrations on a large database can run for many
/// quiet minutes, and a server killed mid-upgrade repeats the upgrade on every
/// launch.
pub const BOOT_STALL_LIMIT: Duration = Duration::from_secs(15 * 60);
const BOOT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const BOOT_LOG_SCAN_LIMIT: u64 = 256 * 1024;
const BOOT_LOG_CARRY_BYTES: usize = 512;
/// Node's raw stdout/stderr. Kept apart from server.log, which the server's
/// own file transport writes: sharing it duplicated every line (once with ANSI
/// color). This file is what holds output from before the logger exists.
const CONSOLE_LOG_NAME: &str = "sidecar.console.log";
const CONSOLE_LOG_PREVIOUS_NAME: &str = "sidecar.console.previous.log";
const CONSOLE_LOG_TRIM_AT: u64 = 16 * 1024 * 1024;
const CONSOLE_LOG_KEEP: u64 = 256 * 1024;
/// Crash-watch polls between console-log size checks (2s each).
const CONSOLE_TRIM_EVERY_POLLS: u32 = 15;
const LOG_TAIL_BYTES: usize = 4000;
/// Server output that means boot is upgrading an existing database rather
/// than just starting (DatabaseBackupService and the migration runner).
const UPGRADE_MARKERS: [&str; 3] = [
    "pending schema migrations",
    "pre-migration backup",
    "[db] Applying ",
];

pub struct SidecarState {
    pub port: u16,
    pub token: String,
    shutdown_token: String,
    /// Separate, per-boot random token gating only POST /api/tools/execute
    /// and /execute/test (act_as impersonation + arbitrary code execution —
    /// see the server's panelAuth.ts for the full trust-boundary writeup).
    /// Minted here exactly like `token` and handed to the sidecar via env, then
    /// injected into the webview out-of-band (main.rs's initialization_script).
    /// The general sidecar token (not this panel-only token) is also written to
    /// a mode-0600, per-session CLI descriptor and removed on shutdown.
    pub panel_token: String,
    /// Per-boot HMAC key proving a native save dialog chose a path.
    ///
    /// Unlike `token` and `panel_token`, this is never injected into the
    /// webview and never written to the CLI session descriptor. That is the
    /// entire point: a value the page can read proves only that the page
    /// asked, which is exactly what an overwrite grant must not be able to
    /// mean. It leaves this process only through the sidecar's environment.
    pub export_grant_key: String,
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
    /// Set once `shutdown` has confirmed Node exited, so a repeated call can
    /// report the first call's outcome instead of assuming success.
    stop_confirmed: AtomicBool,
    /// The server's own log (its file transport).
    log_path: PathBuf,
    /// Length of server.log when this boot's child was spawned; boot progress
    /// is read from here on.
    boot_log_offset: u64,
    /// Node's captured stdout/stderr for this launch.
    console_log_path: PathBuf,
    console_boot_offset: u64,
    cli_session_path: PathBuf,
    // Canonical path remains the source for filesystem operations initiated by
    // the shell (for example, moving a Snaglet home). Process-facing descendants
    // use `pg_data_dir`'s compatible spelling instead.
    home_dir: PathBuf,
    pg_bin_dir: PathBuf,
    pg_ctl_path: PathBuf,
    pg_data_dir: PathBuf,
    pg_stop_lock: Mutex<()>,
    home_lock: LockGuard,
}

pub fn active_home(state: &SidecarState) -> PathBuf {
    state.home_dir.clone()
}

/// Folder holding server.log and the captured console output.
pub fn logs_dir(state: &SidecarState) -> &Path {
    state.log_path.parent().unwrap_or(&state.log_path)
}

/// Release the Snaglet-home lock ahead of process exit so a relaunched shell never
/// races the exiting one for it. Only call once the sidecar is stopped.
pub fn release_home_lock(state: &SidecarState) {
    let _ = unlock_file(&state.home_lock.file);
}

fn lock_child(state: &SidecarState) -> MutexGuard<'_, Option<Child>> {
    state.child.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Convert a filesystem path at a native-process boundary to the ordinary
/// Windows spelling understood by Node, PostgreSQL, and cmd.exe.
///
/// Rust keeps canonical paths internally for locks and private files. Windows
/// canonicalization, however, commonly returns `\\?\C:\...`, which Node can
/// pass to a child through cmd.exe incorrectly. `dunce` removes that prefix
/// only when it is safe; ordinary UNC shares remain ordinary UNC paths. Reject
/// a remaining device/verbatim spelling rather than handing an unsupported
/// path to another process.
pub(crate) fn external_process_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        use std::path::{Component, Prefix};

        let simplified = dunce::simplified(path);
        let unsupported = matches!(
            simplified.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::Verbatim(_) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _) | Prefix::DeviceNS(_)
                )
        );
        if unsupported {
            return Err(format!(
                "{label} uses a Windows device or extended-length path that cannot be safely passed to bundled processes: {}",
                path.display()
            ));
        }
        Ok(simplified.to_path_buf())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = label;
        Ok(path.to_path_buf())
    }
}

pub fn write_home_pointer(target: &Path) -> Result<(), String> {
    let target = external_process_path(target, "Snaglet home pointer")?;
    let pointer = home_pointer_path()?;
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "homePath": target.to_string_lossy(),
        "recentPaths": [target.to_string_lossy()]
    }))
    .map_err(|e| format!("cannot encode Snaglet home pointer: {e}"))?;
    let temporary = pointer.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary, body).map_err(|e| format!("cannot write Snaglet home pointer: {e}"))?;
    fs::rename(temporary, pointer).map_err(|e| format!("cannot publish Snaglet home pointer: {e}"))
}

pub fn clear_home_pointer() -> Result<(), String> {
    fs::write(home_pointer_path()?, b"{}\n")
        .map_err(|e| format!("cannot clear Snaglet home pointer: {e}"))
}

#[derive(Serialize, Clone, Debug)]
pub struct SidecarCrashPayload {
    pub exit_code: Option<i32>,
    pub log_tail: String,
}

#[cfg(target_os = "windows")]
fn read_existing_private_secret_file(path: &Path) -> Result<String, String> {
    let mut file = crate::windows_acl::open_existing_private_secret_file(path)?;
    protect_secret_file_handle(&file, path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| format!("cannot read private file {}: {error}", path.display()))?;
    Ok(contents)
}

#[cfg(not(target_os = "windows"))]
fn read_existing_private_secret_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("cannot read private file {}: {error}", path.display()))
}

fn write_private_secret_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(crate::windows_acl::private_secret_access(true));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("cannot create private file {}: {error}", path.display()))?;
    // Do not write secrets until a private DACL exists. `create_new` gives us
    // a fresh file and the handle prevents a redirected path from being ACLed.
    protect_secret_file_handle(&file, path)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("cannot write private file {}: {error}", path.display()))
}

fn write_cli_session(dir: &Path, port: u16, token: &str) -> Result<PathBuf, String> {
    let runtime_dir = dir.join("runtime");
    fs::create_dir_all(&runtime_dir)
        .map_err(|err| format!("cannot create CLI runtime directory: {err}"))?;
    let path = runtime_dir.join("desktop-cli-session.json");
    let temporary = runtime_dir.join(format!(".desktop-cli-session.{}.tmp", std::process::id()));
    let body = serde_json::to_vec(&serde_json::json!({
        "serverUrl": format!("http://127.0.0.1:{port}"),
        "sidecarToken": token,
        "pid": std::process::id(),
    }))
    .map_err(|err| format!("cannot encode CLI session: {err}"))?;
    write_private_secret_file(&temporary, &body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("cannot protect CLI session: {err}"))?;
    }
    fs::rename(&temporary, &path).map_err(|err| format!("cannot publish CLI session: {err}"))?;
    Ok(path)
}

// Data dir

/// User home directory (`$HOME` / `%USERPROFILE%`).
fn user_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "cannot resolve home directory".to_string())
}

/// Expand a leading `~` / `~/` (or `~\`) against the user home directory.
/// Launchers that read `.env` files deliver `SNAGLET_HOME=~/.snaglet` literally (dotenv
/// performs no shell expansion); without this, the value would resolve
/// against the process cwd and create a misdirected home like `<repo>/~/.snaglet`.
/// Other forms (`~user/...`, relative paths) pass through unchanged and are
/// caught by the absolute-path checks in `data_dir`.
fn expand_home_prefix(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return user_home();
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return Ok(user_home()?.join(rest));
    }
    Ok(PathBuf::from(raw))
}

/// The pointer file `~/.snaglet.json` — lives outside the data dir so it survives
/// a home-path change. Holds `{ "homePath": "..." }` (plus `recentPaths`).
fn home_pointer_path() -> Result<PathBuf, String> {
    Ok(user_home()?.join(".snaglet.json"))
}

/// Read `homePath` from `~/.snaglet.json`, if present and non-empty. Best-effort:
/// a missing/malformed pointer is treated as "no override", never an error.
fn pointer_home_path() -> Option<PathBuf> {
    let path = home_pointer_path().ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    // Minimal extraction — avoid pulling a JSON crate for one key.
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let home = value.get("homePath")?.as_str()?.trim().to_string();
    if home.is_empty() {
        return None;
    }
    // `~`-expand a hand-edited pointer; `data_dir` rejects non-absolute results.
    expand_home_prefix(&home).ok()
}

/// True when `dir` is usable as the data dir: it can be created and written to.
fn is_writable_dir(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".snaglet-write-probe");
    match fs::write(&probe, b"") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Resolve the Snaglet data dir. Precedence:
///   1. `SNAGLET_HOME` env var (explicit override — dev, CI, multi-worktree)
///   2. `homePath` in `~/.snaglet.json` (set by Settings → Profile)
///   3. default `~/.snaglet`
///
/// A configured path is authoritative. If it is unavailable or unwritable we
/// fail closed instead of silently opening a different, apparently empty Snaglet
/// home (a common case when an external volume is disconnected).
pub fn data_dir() -> Result<PathBuf, String> {
    let default_name = if option_env!("SNAGLET_BUILD_PROFILE") == Some("desktop-preview") {
        ".snaglet-preview"
    } else {
        ".snaglet"
    };
    let default_dir = user_home()?.join(default_name);

    if let Ok(custom) = std::env::var("SNAGLET_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let configured = expand_home_prefix(trimmed)?;
            if !configured.is_absolute() {
                return Err(format!(
                    "configured SNAGLET_HOME {} is not an absolute path; use an absolute path or a `~/` prefix (a relative value would resolve against the process working directory)",
                    configured.display()
                ));
            }
            if !is_writable_dir(&configured) {
                return Err(format!(
                    "configured SNAGLET_HOME {} is unavailable or not writable; reconnect it or choose another Snaglet home",
                    configured.display()
                ));
            }
            return Ok(configured);
        }
    }

    if let Some(configured) = pointer_home_path() {
        if !configured.is_absolute() {
            return Err(format!(
                "saved Snaglet home {} is not an absolute path; fix homePath in ~/.snaglet.json (use an absolute path or a `~/` prefix)",
                configured.display()
            ));
        }
        if is_writable_dir(&configured) {
            return Ok(configured);
        }
        return Err(format!(
            "saved Snaglet home {} is unavailable or not writable; reconnect it, update ~/.snaglet.json, or explicitly select the default home {}",
            configured.display(),
            default_dir.display()
        ));
    }

    Ok(default_dir)
}

// Lockfile

struct LockGuard {
    // Keep the descriptor/handle open for the process lifetime. Its OS lock
    // is released after a crash, so stale metadata is safe to recover.
    file: File,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // kill() treats 0 and negative ids as process groups, which always
    // "exist"; no recorded Snaglet pid is ever one of those.
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // Signal 0 — liveness probe only.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let alive =
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn pid_alive(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn try_lock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn try_lock_file(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };

    let mut overlapped = unsafe { std::mem::zeroed() };
    if unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    } != 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;

    let mut overlapped = unsafe { std::mem::zeroed() };
    if unsafe { UnlockFileEx(file.as_raw_handle(), 0, 1, 0, &mut overlapped) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn try_lock_file(_file: &File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn unlock_file(_file: &File) -> std::io::Result<()> {
    Ok(())
}

/// Acquire `<data_dir>/data.lock` with a kernel-held exclusive lock. Windows
/// treats an unlocked PID-only record as stale; Unix retains its live-PID
/// refusal while old PID-only shells may still be installed.
fn acquire_lock(dir: &Path) -> Result<LockGuard, String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create data dir: {e}"))?;
    let path = dir.join("data.lock");
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("cannot open lockfile {}: {e}", path.display()))?;
    if let Err(error) = try_lock_file(&file) {
        return Err(format!(
            "another Snaglet process already holds {}: {error}",
            path.display()
        ));
    }
    let mut existing_contents = String::new();
    file.read_to_string(&mut existing_contents)
        .map_err(|e| format!("cannot read lockfile {}: {e}", path.display()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("cannot rewind lockfile {}: {e}", path.display()))?;
    if let Ok(pid) = existing_contents.trim().parse::<u32>() {
        if pid != std::process::id() && pid_alive(pid) {
            #[cfg(target_os = "windows")]
            {
                // Windows has no earlier packaged shell with an advisory lock,
                // so an unlocked PID-only record can only be stale and may have
                // been reused by an unrelated process.
                eprintln!(
                    "[shell] recovering unlocked Snaglet lock {} with a live recorded pid {pid}",
                    path.display()
                );
            }
            #[cfg(unix)]
            {
                return Err(format!(
                    "another Snaglet process (pid {pid}) may hold legacy lock {}",
                    path.display()
                ));
            }
        }
        // Windows replaces the record under its kernel-held lock. Unix reaches
        // here only for a dead legacy PID record or a current shell record.
    }
    file.set_len(0)
        .and_then(|_| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(std::process::id().to_string().as_bytes()))
        .and_then(|_| file.sync_data())
        .map_err(|e| format!("cannot update lockfile {}: {e}", path.display()))?;
    Ok(LockGuard { file })
}

// Port / token / key

fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("cannot pick free port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read local addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn session_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Per-install 64-hex credential-encryption key, created on first run.
/// The file keeps first-run setup self-contained for packaged desktop builds.
fn credential_key(dir: &Path) -> Result<String, String> {
    let path = dir.join("credential.key");
    if path.exists() {
        let existing = read_existing_private_secret_file(&path)?;
        let trimmed = existing.trim().to_string();
        if trimmed.len() == 64 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(trimmed);
        }
        return Err(
            "credential.key is malformed; refusing to replace it because doing so would make stored credentials unrecoverable"
                .to_string(),
        );
    }
    if dir.join("postgres").join("PG_VERSION").exists() {
        return Err(
            "credential.key is missing beside an existing Snaglet database; refusing to generate a replacement key. Restore the original key or recover from a complete Snaglet-home backup"
                .to_string(),
        );
    }
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_private_secret_file(&path, key.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

// Node binary + server resources

/// The bundled Node sidecar binary (Tauri externalBin lands next to the app
/// binary, suffixed in dev). Falls back to PATH `node` for `tauri dev`.
pub(crate) fn node_binary() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["snaglet-node", "snaglet-node.exe"] {
                let candidate = dir.join(name);
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from("node")
}

pub(crate) fn hide_windows_console(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW prevents the managed Node/PostgreSQL helpers from
        // flashing a console when Snaglet was launched from Explorer.
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

fn pg_executable(bin_dir: &Path, name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return bin_dir.join(format!("{name}.exe"));
    }
    #[cfg(not(target_os = "windows"))]
    bin_dir.join(name)
}

/// The bundled ripgrep (`<resources>/rg/rg`) that agent code search runs, or
/// `None` when it is absent. Optional by design: without it the server falls
/// back to `rg` on PATH, then to its plain-text Node search.
fn bundled_ripgrep(rg_root: &Path) -> Option<PathBuf> {
    let executable = rg_root.join(if cfg!(target_os = "windows") {
        "rg.exe"
    } else {
        "rg"
    });
    if !executable.is_file() {
        return None;
    }
    external_process_path(&executable, "bundled ripgrep").ok()
}

// Spawn + health

fn http_health_ok(port: u16) -> bool {
    use std::io::{Read, Write as _};
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    if stream
        .write_all(
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
}

/// Drop ANSI escape sequences (the server's console format colors levels).
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// The most useful recent output for a failure dialog: Node's console, which
/// includes crashes from before the logger exists, falling back to server.log.
fn failure_tail(state: &SidecarState) -> String {
    let console = strip_ansi(&log_tail(&state.console_log_path, LOG_TAIL_BYTES));
    if console.trim().is_empty() {
        log_tail(&state.log_path, LOG_TAIL_BYTES)
    } else {
        console
    }
}

/// Start this launch's console capture, keeping the previous launch's as
/// `sidecar.console.previous.log`.
fn open_console_log(logs_dir: &Path) -> Result<File, String> {
    let current = logs_dir.join(CONSOLE_LOG_NAME);
    if current.exists() {
        let _ = fs::rename(&current, logs_dir.join(CONSOLE_LOG_PREVIOUS_NAME));
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)
        .map_err(|e| format!("cannot open sidecar console log: {e}"))?;
    // If the rotation above failed, start empty anyway.
    let _ = file.set_len(0);
    Ok(file)
}

/// Keep the running session's console capture bounded. Node holds the file in
/// append mode, so its next write lands at the new end.
pub(crate) fn trim_console_log(path: &Path, trim_at: u64, keep: u64) -> std::io::Result<bool> {
    let len = fs::metadata(path)?.len();
    if len <= trim_at {
        return Ok(false);
    }
    let tail = read_byte_range(path, len.saturating_sub(keep), len).unwrap_or_default();
    OpenOptions::new().write(true).open(path)?.set_len(0)?;
    let mut appender = OpenOptions::new().append(true).open(path)?;
    appender.write_all(
        format!(
            "[shell] console log trimmed to its last {} KB\n",
            keep / 1024
        )
        .as_bytes(),
    )?;
    appender.write_all(&tail)?;
    Ok(true)
}

fn log_tail(path: &Path, max_bytes: usize) -> String {
    match fs::read(path) {
        Ok(bytes) => {
            let start = bytes.len().saturating_sub(max_bytes);
            String::from_utf8_lossy(&bytes[start..]).to_string()
        }
        Err(_) => String::new(),
    }
}

/// Spawn the sidecar and return as soon as the Node child exists; follow with
/// [`wait_until_ready`]. Returning early lets the shell register the state for
/// quit-time shutdown and show a window while boot runs.
/// Emits `sidecar-status` events: `starting` → `ready` | `failed`.
pub fn launch(
    app: &tauri::AppHandle,
    server_dir: &Path,
    pg_root: &Path,
    rg_root: &Path,
) -> Result<&'static SidecarState, String> {
    let requested_dir = data_dir()?;
    fs::create_dir_all(&requested_dir)
        .map_err(|e| format!("cannot create Snaglet data directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&requested_dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot secure Snaglet data directory: {e}"))?;
    }
    let dir = dunce::canonicalize(&requested_dir)
        .map_err(|e| format!("cannot resolve Snaglet data directory: {e}"))?;
    let process_dir = external_process_path(&dir, "Snaglet home")?;
    let lock = acquire_lock(&dir)?;
    let port = free_port()?;
    let token = session_token();
    let shutdown_token = session_token();
    let panel_token = session_token();
    let export_grant_key = crate::export_grant::generate_key();
    let cred_key = credential_key(&dir)?;
    let pg_root = dunce::canonicalize(pg_root)
        .map_err(|e| format!("cannot resolve packaged PostgreSQL runtime: {e}"))?;
    let pg_root = external_process_path(&pg_root, "packaged PostgreSQL runtime")?;
    let pg_bin_dir = pg_root.join("bin");
    let pg_ctl_path = pg_executable(&pg_bin_dir, "pg_ctl");
    let pg_data_dir = process_dir.join("postgres");
    for required in ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore"] {
        let executable = pg_executable(&pg_bin_dir, required);
        if !executable.is_file() {
            return Err(format!(
                "packaged PostgreSQL executable missing: {}",
                executable.display()
            ));
        }
    }

    let logs_dir = dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| format!("cannot create logs dir: {e}"))?;
    let log_path = logs_dir.join("server.log");
    let boot_log_offset = fs::metadata(&log_path).map(|meta| meta.len()).unwrap_or(0);
    let console_log_path = logs_dir.join(CONSOLE_LOG_NAME);
    let console_log = open_console_log(&logs_dir)?;
    let console_boot_offset = console_log.metadata().map(|meta| meta.len()).unwrap_or(0);
    let console_log_err = console_log
        .try_clone()
        .map_err(|e| format!("cannot clone log handle: {e}"))?;

    let server_dir = external_process_path(server_dir, "server bundle")?;
    let server_mjs = server_dir.join("server.mjs");
    if !server_mjs.exists() {
        return Err(format!("server bundle missing: {}", server_mjs.display()));
    }

    let _ = app.emit("sidecar-status", "starting");
    let node_binary = external_process_path(&node_binary(), "bundled Node executable")?;
    let mut node_command = Command::new(node_binary);
    hide_windows_console(&mut node_command);
    // Point code search at the bundled ripgrep; never inherit a value from
    // the launching environment.
    match bundled_ripgrep(rg_root) {
        Some(rg) => node_command.env("SNAGLET_RIPGREP_PATH", rg),
        None => node_command.env_remove("SNAGLET_RIPGREP_PATH"),
    };
    let child = node_command
        .arg("server.mjs")
        .current_dir(server_dir)
        .env("NODE_ENV", "production")
        .env(
            "SNAGLET_APP_VERSION",
            app.package_info().version.to_string(),
        )
        // The standalone server keeps automatic local inference opt-in so a
        // developer or test process never downloads models unexpectedly. The
        // packaged desktop is the product opt-in: first launch must seed the
        // built-in embedder without requiring a repo-only env var. The reranker
        // is seeded only once its `reranker` feature flag is on.
        .env("SNAGLET_LOCAL_INTELLIGENCE", "true")
        .env("PORT", port.to_string())
        .env("API_BASE_URL", format!("http://127.0.0.1:{port}"))
        .env(
            "SNAGLET_ALLOWED_ORIGINS",
            format!("http://127.0.0.1:{port}"),
        )
        // Keep the real OS HOME intact for user-facing `~/...` filesystem
        // paths. Snaglet-owned state derives exclusively from SNAGLET_HOME.
        .env("SNAGLET_HOME", &process_dir)
        .env("SNAGLET_LOG_DIR", process_dir.join("logs"))
        .env_remove("DATABASE_URL")
        .env_remove("SNAGLET_DATABASE_URL")
        .env_remove("SNAGLET_DB_CONFIG_PATH")
        .env("SNAGLET_DB_MODE", "managed")
        .env("SNAGLET_PG_BINDIR", &pg_bin_dir)
        .env("SNAGLET_PG_DATA_DIR", &pg_data_dir)
        .env("SNAGLET_PG_OWNED", "1")
        .env("SNAGLET_BACKUPS_DIR", process_dir.join("backups"))
        .env("SNAGLET_AUTH_TOKEN", &token)
        .env("SNAGLET_SHUTDOWN_TOKEN", &shutdown_token)
        .env("SNAGLET_PANEL_TOKEN", &panel_token)
        .env("SNAGLET_EXPORT_GRANT_KEY", &export_grant_key)
        .env("SNAGLET_PARENT_PID", std::process::id().to_string())
        .env("CREDENTIAL_ENCRYPTION_KEY", cred_key)
        .stdout(Stdio::from(console_log))
        .stderr(Stdio::from(console_log_err))
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar node process: {e}"))?;

    let cli_session_path = dir.join("runtime").join("desktop-cli-session.json");
    let state: &'static SidecarState = Box::leak(Box::new(SidecarState {
        port,
        token,
        shutdown_token,
        panel_token,
        export_grant_key,
        child: Mutex::new(Some(child)),
        shutting_down: AtomicBool::new(false),
        stop_confirmed: AtomicBool::new(false),
        log_path,
        boot_log_offset,
        console_log_path,
        console_boot_offset,
        cli_session_path,
        home_dir: dir,
        pg_bin_dir,
        pg_ctl_path,
        pg_data_dir,
        pg_stop_lock: Mutex::new(()),
        home_lock: lock,
    }));
    Ok(state)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootPhase {
    Starting,
    UpgradingDatabase,
}

/// What the shell shows while [`wait_until_ready`] polls.
pub trait BootObserver {
    /// Called on every poll that is still waiting.
    fn progress(&mut self, phase: BootPhase, elapsed: Duration);
    /// Boot produced no output for [`BOOT_STALL_LIMIT`]. Return `true` to keep
    /// waiting (the stall clock restarts) or `false` to give up.
    fn keep_waiting(&mut self, phase: BootPhase, stalled_for: Duration) -> bool;
}

#[derive(Debug)]
pub enum BootFailure {
    /// A shutdown began elsewhere (the app is quitting); nothing to report.
    Canceled,
    /// The user chose to quit rather than keep waiting. The sidecar is still
    /// running; the app's exit path stops it.
    Declined,
    /// The server exited or could not be published; it has been shut down.
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BootCheck {
    Ready,
    Exited,
    Waiting,
    Stalled,
}

/// Boot policy: a live server is never failed for being slow. Only an exit
/// ends boot on its own; a long silence asks the user.
pub(crate) fn boot_check(
    exited: bool,
    healthy: bool,
    since_progress: Duration,
    stall_limit: Duration,
) -> BootCheck {
    if exited {
        BootCheck::Exited
    } else if healthy {
        BootCheck::Ready
    } else if since_progress >= stall_limit {
        BootCheck::Stalled
    } else {
        BootCheck::Waiting
    }
}

pub(crate) fn detect_boot_phase(output: &str) -> Option<BootPhase> {
    UPGRADE_MARKERS
        .iter()
        .any(|marker| output.contains(marker))
        .then_some(BootPhase::UpgradingDatabase)
}

fn tail_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(max_bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Follows server.log during boot: any growth counts as progress, and known
/// markers switch the phase to a database upgrade.
struct BootLogWatch {
    path: PathBuf,
    offset: u64,
    carry: String,
    phase: BootPhase,
}

impl BootLogWatch {
    fn new(path: &Path, offset: u64) -> Self {
        Self {
            path: path.to_path_buf(),
            offset,
            carry: String::new(),
            phase: BootPhase::Starting,
        }
    }

    /// Returns true when the server wrote anything since the last poll.
    fn poll(&mut self) -> bool {
        let Ok(len) = fs::metadata(&self.path).map(|meta| meta.len()) else {
            return false;
        };
        if len < self.offset {
            // The server's logger rotated or truncated the file.
            self.offset = 0;
            self.carry.clear();
        }
        if len == self.offset {
            return false;
        }
        if self.phase == BootPhase::Starting {
            let start = self.offset.max(len.saturating_sub(BOOT_LOG_SCAN_LIMIT));
            if let Some(chunk) = read_byte_range(&self.path, start, len) {
                let text = format!("{}{}", self.carry, String::from_utf8_lossy(&chunk));
                if let Some(phase) = detect_boot_phase(&text) {
                    self.phase = phase;
                }
                self.carry = tail_at_char_boundary(&text, BOOT_LOG_CARRY_BYTES).to_string();
            }
        }
        self.offset = len;
        true
    }
}

fn read_byte_range(path: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(end.saturating_sub(start))
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

enum ChildPoll {
    Running,
    Exited(std::process::ExitStatus),
    /// `shutdown` already took the child.
    Gone,
}

fn poll_child(state: &SidecarState) -> ChildPoll {
    let mut guard = lock_child(state);
    match guard.as_mut() {
        None => ChildPoll::Gone,
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => ChildPoll::Exited(status),
            _ => ChildPoll::Running,
        },
    }
}

/// Block until the launched server answers /health, then publish the CLI
/// session. Runs off the main thread; `observer` drives the splash window.
pub fn wait_until_ready(
    app: &tauri::AppHandle,
    state: &'static SidecarState,
    observer: &mut dyn BootObserver,
) -> Result<(), BootFailure> {
    let started = Instant::now();
    let mut last_progress = started;
    // Winston's console transport mirrors into the console capture, and
    // console.log-only lines (the migration runner) appear only there; read
    // both so neither a quiet file nor a disabled transport hides progress.
    let mut logs = [
        BootLogWatch::new(&state.console_log_path, state.console_boot_offset),
        BootLogWatch::new(&state.log_path, state.boot_log_offset),
    ];
    loop {
        if state.shutting_down.load(Ordering::SeqCst) {
            return Err(BootFailure::Canceled);
        }
        let exit_status = match poll_child(state) {
            ChildPoll::Gone => return Err(BootFailure::Canceled),
            ChildPoll::Running => None,
            ChildPoll::Exited(status) => Some(status),
        };
        let healthy = exit_status.is_none() && http_health_ok(state.port);
        let grew = logs.iter_mut().fold(false, |grew, log| log.poll() | grew);
        if grew {
            last_progress = Instant::now();
        }
        let phase = if logs
            .iter()
            .any(|log| log.phase == BootPhase::UpgradingDatabase)
        {
            BootPhase::UpgradingDatabase
        } else {
            BootPhase::Starting
        };
        let now = Instant::now();
        match boot_check(
            exit_status.is_some(),
            healthy,
            now.duration_since(last_progress),
            BOOT_STALL_LIMIT,
        ) {
            BootCheck::Ready => break,
            BootCheck::Exited => {
                let _ = app.emit("sidecar-status", "failed");
                let detail = format!(
                    "sidecar exited during boot (code {:?}).\n--- recent output ({}) ---\n{}",
                    exit_status.and_then(|status| status.code()),
                    logs_dir(state).display(),
                    failure_tail(state)
                );
                shutdown(state);
                return Err(BootFailure::Failed(detail));
            }
            BootCheck::Stalled => {
                if observer.keep_waiting(phase, now.duration_since(last_progress)) {
                    last_progress = Instant::now();
                } else {
                    let _ = app.emit("sidecar-status", "failed");
                    return Err(BootFailure::Declined);
                }
            }
            BootCheck::Waiting => observer.progress(phase, now.duration_since(started)),
        }
        std::thread::sleep(BOOT_POLL_INTERVAL);
    }

    let _ = app.emit("sidecar-status", "ready");
    if let Err(err) = write_cli_session(&state.home_dir, state.port, &state.token) {
        shutdown(state);
        return Err(BootFailure::Failed(err));
    }
    Ok(())
}

/// Watch a ready sidecar for an unexpected exit. On a crash the owned
/// PostgreSQL cluster is stopped, `sidecar-crashed` is emitted, and
/// `on_crash` runs on the watcher thread (the shell shows Restart / Quit).
pub fn watch_for_crash<F>(app: &tauri::AppHandle, state: &'static SidecarState, on_crash: F)
where
    F: FnOnce(SidecarCrashPayload) + Send + 'static,
{
    let app = app.clone();
    let mut polls: u32 = 0;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        polls = polls.wrapping_add(1);
        if polls.is_multiple_of(CONSOLE_TRIM_EVERY_POLLS) {
            let _ = trim_console_log(
                &state.console_log_path,
                CONSOLE_LOG_TRIM_AT,
                CONSOLE_LOG_KEEP,
            );
        }
        let status = match poll_child(state) {
            ChildPoll::Gone => return,
            ChildPoll::Running => continue,
            ChildPoll::Exited(status) => status,
        };
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let _ = fs::remove_file(&state.cli_session_path);
        stop_postgres_if_running(state);
        let payload = SidecarCrashPayload {
            exit_code: status.code(),
            log_tail: failure_tail(state),
        };
        let _ = app.emit("sidecar-crashed", payload.clone());
        on_crash(payload);
        return;
    });
}

fn postgres_command(state: &SidecarState) -> Command {
    let mut command = Command::new(&state.pg_ctl_path);
    hide_windows_console(&mut command);
    let mut paths = vec![state.pg_bin_dir.clone()];
    if let Some(existing_path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing_path));
    }
    if let Ok(path_value) = std::env::join_paths(paths) {
        command.env("PATH", path_value);
    }
    if let Some(pg_root) = state.pg_bin_dir.parent() {
        let lib_dir = pg_root.join("lib");
        for variable in ["DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH"] {
            let mut libraries = vec![lib_dir.clone()];
            if let Some(existing) = std::env::var_os(variable) {
                libraries.extend(std::env::split_paths(&existing));
            }
            if let Ok(value) = std::env::join_paths(libraries) {
                command.env(variable, value);
            }
        }
    }
    command
}

fn request_graceful_shutdown(state: &SidecarState) -> Result<(), String> {
    use std::io::{Read, Write};

    let address = format!("127.0.0.1:{}", state.port)
        .parse()
        .map_err(|error| format!("cannot parse sidecar address: {error}"))?;
    let mut stream = std::net::TcpStream::connect_timeout(&address, SHUTDOWN_CONNECT_TIMEOUT)
        .map_err(|error| format!("cannot connect to sidecar shutdown endpoint: {error}"))?;
    stream
        .set_read_timeout(Some(SHUTDOWN_REQUEST_TIMEOUT))
        .map_err(|error| format!("cannot set sidecar shutdown read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(SHUTDOWN_REQUEST_TIMEOUT))
        .map_err(|error| format!("cannot set sidecar shutdown write timeout: {error}"))?;
    let request = format!(
        "POST /api/server/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Snaglet-Token: {}\r\nX-Snaglet-Shutdown-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        state.port, state.token, state.shutdown_token
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("cannot request graceful sidecar shutdown: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("cannot read sidecar shutdown response: {error}"))?;
    if response.starts_with("HTTP/1.1 202") || response.starts_with("HTTP/1.0 202") {
        Ok(())
    } else {
        Err(format!(
            "sidecar shutdown endpoint rejected the request: {}",
            response.lines().next().unwrap_or("empty response")
        ))
    }
}

fn stop_postgres_if_running(state: &SidecarState) {
    let Ok(_stop_guard) = state.pg_stop_lock.lock() else {
        eprintln!("[shell] packaged PostgreSQL stop lock is poisoned; preserving the cluster");
        return;
    };
    if !state.pg_data_dir.join("postmaster.pid").exists() {
        return;
    }

    let status = postgres_command(state)
        .args(["status", "-D"])
        .arg(&state.pg_data_dir)
        .output();
    match status {
        Ok(output) if output.status.success() => {}
        Ok(output) if output.status.code() == Some(3) => return,
        Ok(output) => {
            eprintln!(
                "[shell] packaged PostgreSQL status was inconclusive for {}; preserving it: {}{}",
                state.pg_data_dir.display(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        Err(error) => {
            eprintln!(
                "[shell] could not check packaged PostgreSQL {}: {error}; preserving it",
                state.pg_data_dir.display()
            );
            return;
        }
    }

    let mut command = postgres_command(state);
    command.args(["stop", "-D"]).arg(&state.pg_data_dir).args([
        "-m",
        "immediate",
        "-w",
        "-t",
        POSTGRES_STOP_TIMEOUT_SECS,
    ]);
    match command.output() {
        Ok(output) if output.status.success() => {
            eprintln!(
                "[shell] stopped packaged PostgreSQL after sidecar exit ({})",
                state.pg_data_dir.display()
            );
        }
        Ok(output) => {
            eprintln!(
                "[shell] packaged PostgreSQL immediate stop failed for {}: {}{}",
                state.pg_data_dir.display(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Err(error) => {
            eprintln!(
                "[shell] could not invoke packaged pg_ctl {}: {error}",
                state.pg_ctl_path.display()
            );
        }
    }
}

/// Graceful shutdown lets the server drain runs, close the pool, and fast-stop
/// its owned PostgreSQL cluster. After the bounded drain,
/// SIGKILL applies only to Node; the exact packaged cluster then receives an
/// immediate pg_ctl stop without deleting or renaming any data.
///
/// Blocks for up to about a minute, so never call it on the main thread while
/// the UI is live. Returns whether Node is confirmed stopped; repeated calls
/// report the first call's outcome.
pub fn shutdown(state: &SidecarState) -> bool {
    state.shutting_down.store(true, Ordering::SeqCst);
    let _ = fs::remove_file(&state.cli_session_path);
    let mut guard = lock_child(state);
    if let Some(mut child) = guard.take() {
        let graceful_requested = match request_graceful_shutdown(state) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[shell] graceful sidecar shutdown unavailable: {error}");
                false
            }
        };
        let initial_status = child.try_wait();
        let mut node_confirmed_exited = matches!(initial_status, Ok(Some(_)));
        if matches!(initial_status, Ok(None)) {
            if !graceful_requested {
                #[cfg(unix)]
                unsafe {
                    // The preflight above proves the Child has not already been
                    // reaped, avoiding a raw signal to a recycled PID.
                    libc::kill(child.id() as i32, libc::SIGTERM);
                }
                #[cfg(not(unix))]
                let _ = child.kill();
            }

            // The server stops new work and cancels active runs before this
            // bounded exit wait. The final pg_ctl fallback adds at most 20s.
            let deadline = Instant::now() + SIDECAR_EXIT_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        node_confirmed_exited = true;
                        break;
                    }
                    Ok(None) if Instant::now() > deadline => {
                        if child.kill().is_ok() {
                            node_confirmed_exited = child.wait().is_ok();
                        }
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                    Err(error) => {
                        eprintln!("[shell] could not poll sidecar exit: {error}");
                        if child.kill().is_ok() {
                            node_confirmed_exited = child.wait().is_ok();
                        }
                        break;
                    }
                }
            }
        } else if let Err(error) = initial_status {
            eprintln!("[shell] could not perform sidecar shutdown preflight: {error}");
            if child.kill().is_ok() {
                node_confirmed_exited = child.wait().is_ok();
            }
        }
        if node_confirmed_exited {
            stop_postgres_if_running(state);
            state.stop_confirmed.store(true, Ordering::SeqCst);
        } else {
            eprintln!(
                "[shell] sidecar death could not be confirmed; preserving PostgreSQL for adoption"
            );
        }
    }
    state.stop_confirmed.load(Ordering::SeqCst)
}

/// True when the owned cluster is not running, so its data directory is safe
/// to copy. Inconclusive answers count as running.
pub fn postgres_is_stopped(state: &SidecarState) -> bool {
    if !state.pg_data_dir.join("postmaster.pid").exists() {
        return true;
    }
    matches!(
        postgres_command(state)
            .args(["status", "-D"])
            .arg(&state.pg_data_dir)
            .output(),
        Ok(output) if output.status.code() == Some(3)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_lock_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "snaglet-sidecar-lock-test-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn bundled_ripgrep_resolves_only_an_existing_executable() {
        let root =
            std::env::temp_dir().join(format!("snaglet-sidecar-rg-test-{}", uuid::Uuid::new_v4()));
        let name = if cfg!(target_os = "windows") {
            "rg.exe"
        } else {
            "rg"
        };
        assert_eq!(bundled_ripgrep(&root), None);
        fs::create_dir_all(root.join(name)).expect("create directory named like rg");
        assert_eq!(
            bundled_ripgrep(&root),
            None,
            "a directory is not the executable"
        );
        fs::remove_dir(root.join(name)).expect("remove directory");
        fs::write(root.join(name), b"").expect("create placeholder rg");
        assert_eq!(bundled_ripgrep(&root), Some(root.join(name)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lock_rejects_a_concurrent_owner_and_recovers_a_stale_record() {
        let dir = temporary_lock_dir();
        let first = acquire_lock(&dir).expect("first lock should succeed");
        assert!(acquire_lock(&dir).is_err());
        drop(first);

        fs::write(dir.join("data.lock"), "0").expect("write stale lock record");
        let recovered = acquire_lock(&dir).expect("stale record should be recovered");
        drop(recovered);
        fs::remove_dir_all(&dir).expect("remove disposable lock test directory");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn lock_recovers_a_pid_record_reused_by_an_unrelated_live_process() {
        let dir = temporary_lock_dir();
        fs::create_dir_all(&dir).expect("create disposable lock test directory");
        let mut unrelated = Command::new("cmd")
            .args(["/C", "ping -n 5 127.0.0.1 >nul"])
            .spawn()
            .expect("start unrelated process");
        fs::write(dir.join("data.lock"), unrelated.id().to_string())
            .expect("write compatible stale pid record");

        let recovered = acquire_lock(&dir).expect("kernel lock permits recovery despite live pid");
        drop(recovered);
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        fs::remove_dir_all(&dir).expect("remove disposable lock test directory");
    }

    #[test]
    fn boot_never_fails_a_live_server_for_being_slow() {
        let limit = BOOT_STALL_LIMIT;
        // Well past 90 s, still producing output.
        assert_eq!(
            boot_check(false, false, Duration::from_secs(5), limit),
            BootCheck::Waiting
        );
        assert_eq!(
            boot_check(false, false, limit - Duration::from_secs(1), limit),
            BootCheck::Waiting
        );
        // Silence only asks; it is not an exit.
        assert_eq!(boot_check(false, false, limit, limit), BootCheck::Stalled);
        assert_eq!(boot_check(false, true, limit * 2, limit), BootCheck::Ready);
        // An exit wins over anything else observed in the same poll.
        assert_eq!(
            boot_check(true, true, Duration::ZERO, limit),
            BootCheck::Exited
        );
        assert_eq!(boot_check(true, false, limit, limit), BootCheck::Exited);
    }

    #[test]
    fn upgrade_markers_switch_the_boot_phase() {
        assert_eq!(
            detect_boot_phase(
                "2026-01-01 00:00:00 info: [db-backup] pending schema migrations — taking pre-migration snapshot"
            ),
            Some(BootPhase::UpgradingDatabase)
        );
        assert_eq!(
            detect_boot_phase("[db] Applying 3 migration(s)..."),
            Some(BootPhase::UpgradingDatabase)
        );
        assert_eq!(detect_boot_phase("[db] No pending migrations"), None);
        assert_eq!(
            detect_boot_phase("[db] Fresh database — applying 1 migration(s)..."),
            None
        );
    }

    #[test]
    fn boot_log_watch_reports_growth_markers_and_rotation() {
        let dir = temporary_lock_dir();
        fs::create_dir_all(&dir).expect("create disposable log directory");
        let path = dir.join("server.log");
        fs::write(&path, "previous boot: [db] Applying 9 migration(s)...\n").expect("seed log");
        let offset = fs::metadata(&path).expect("log metadata").len();
        let mut watch = BootLogWatch::new(&path, offset);

        // Output from an earlier boot is not this boot's progress or phase.
        assert!(!watch.poll());
        assert_eq!(watch.phase, BootPhase::Starting);

        let append = |text: &str| {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("open log");
            file.write_all(text.as_bytes()).expect("append log");
        };
        append("PostgreSQL ready\n[db-backup] pending schema ");
        assert!(watch.poll());
        assert_eq!(watch.phase, BootPhase::Starting);
        // A marker split across two writes is still recognized.
        append("migrations — taking pre-migration snapshot\n");
        assert!(watch.poll());
        assert_eq!(watch.phase, BootPhase::UpgradingDatabase);
        assert!(!watch.poll());

        fs::write(&path, "rotated\n").expect("rotate log");
        assert!(watch.poll());
        fs::remove_dir_all(&dir).expect("remove disposable log directory");
    }

    #[test]
    fn strip_ansi_removes_color_codes_only() {
        assert_eq!(
            strip_ansi("2026-01-01 \u{1b}[31merror\u{1b}[39m: boom \u{1b}[2m{\"id\":1}\u{1b}[0m"),
            "2026-01-01 error: boom {\"id\":1}"
        );
        assert_eq!(strip_ansi("plain — text"), "plain — text");
        assert_eq!(strip_ansi("dangling \u{1b}"), "dangling ");
    }

    #[test]
    fn console_log_rotates_per_launch_and_trims_while_running() {
        let dir = temporary_lock_dir();
        fs::create_dir_all(&dir).expect("create disposable log directory");
        let current = dir.join(CONSOLE_LOG_NAME);
        fs::write(&current, "previous launch output\n").expect("seed console log");

        let mut file = open_console_log(&dir).expect("open console log");
        assert_eq!(fs::metadata(&current).expect("fresh log").len(), 0);
        assert_eq!(
            fs::read_to_string(dir.join(CONSOLE_LOG_PREVIOUS_NAME)).expect("previous kept"),
            "previous launch output\n"
        );

        file.write_all(&vec![b'a'; 1500]).expect("write output");
        file.write_all(b"last line\n").expect("write output");
        assert!(!trim_console_log(&current, 4096, 64).expect("small log untouched"));
        assert!(trim_console_log(&current, 1000, 64).expect("trim large log"));
        let trimmed = fs::read_to_string(&current).expect("read trimmed log");
        assert!(trimmed.starts_with("[shell] console log trimmed"));
        assert!(trimmed.ends_with("last line\n"));
        assert!(trimmed.len() < 200);

        // The writer keeps appending at the new end, not at its old offset.
        file.write_all(b"after trim\n").expect("append after trim");
        let appended = fs::read_to_string(&current).expect("read appended log");
        assert!(appended.ends_with("last line\nafter trim\n"));
        assert!(!appended.contains('\0'));
        fs::remove_dir_all(&dir).expect("remove disposable log directory");
    }

    #[test]
    fn postgres_executable_uses_the_platform_extension() {
        let binary = pg_executable(Path::new("runtime/bin"), "pg_ctl");
        #[cfg(target_os = "windows")]
        assert_eq!(binary, PathBuf::from("runtime/bin/pg_ctl.exe"));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(binary, PathBuf::from("runtime/bin/pg_ctl"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn external_process_paths_strip_only_safe_verbatim_disk_prefixes() {
        let mut verbatim_unicode = PathBuf::from(r"\\?\C:\Users\Test User");
        verbatim_unicode.push("Home with spaces ü 日本");
        let mut expected_unicode = PathBuf::from(r"C:\Users\Test User");
        expected_unicode.push("Home with spaces ü 日本");
        assert_eq!(
            external_process_path(&verbatim_unicode, "Snaglet home")
                .expect("safe verbatim disk path"),
            expected_unicode
        );
        assert_eq!(
            external_process_path(
                Path::new(r"\\fileserver\Snaglet share\home"),
                "Snaglet home"
            )
            .expect("ordinary UNC share"),
            PathBuf::from(r"\\fileserver\Snaglet share\home")
        );
        assert!(external_process_path(Path::new(r"\\?\C:\CON"), "Snaglet home").is_err());
        assert!(external_process_path(Path::new(r"\\.\PhysicalDrive0"), "Snaglet home").is_err());
    }
}
