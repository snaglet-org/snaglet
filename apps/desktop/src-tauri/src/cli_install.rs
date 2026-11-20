use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const LAUNCHER_MARKER: &str = "# Snaglet CLI launcher — managed by Snaglet Desktop";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub available: bool,
    pub installed: bool,
    pub current: bool,
    pub conflict: bool,
    pub launcher_path: String,
    pub cli_path: String,
    pub path_configured: bool,
    pub path_export_command: String,
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "cannot resolve user home directory".to_string())
}

#[cfg(not(target_os = "windows"))]
fn launcher_path() -> Result<PathBuf, String> {
    Ok(user_home()?.join(".local").join("bin").join("snaglet"))
}

#[cfg(target_os = "windows")]
fn launcher_path() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(user_home()?.join("AppData").join("Local"));
    Ok(local_app_data
        .join("Snaglet")
        .join("bin")
        .join("snaglet.cmd"))
}

#[cfg(not(target_os = "windows"))]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(not(target_os = "windows"))]
fn launcher_contents(node: &Path, cli: &Path, snaglet_home: &Path) -> String {
    format!(
        "#!/bin/sh\n{LAUNCHER_MARKER}\nexport SNAGLET_HOME={}\nexec {} {} \"$@\"\n",
        shell_quote(snaglet_home),
        shell_quote(node),
        shell_quote(cli)
    )
}

#[cfg(target_os = "windows")]
fn launcher_contents(node: &Path, cli: &Path, snaglet_home: &Path) -> String {
    // A .cmd launcher remains usable from cmd.exe and PowerShell without a
    // POSIX shell. UTF-8 lets cmd parse Unicode resource paths; restore the
    // caller's code page before returning so a launcher invocation has no
    // lasting console side effect. Double quotes cannot occur in Windows paths.
    format!(
        "@echo off\r\nrem {LAUNCHER_MARKER}\r\nsetlocal DisableDelayedExpansion\r\nfor /f \"tokens=2 delims=:\" %%A in ('chcp') do set \"SNAGLET_ORIGINAL_CODEPAGE=%%A\"\r\nchcp 65001 >nul\r\nset \"SNAGLET_HOME={}\"\r\n\"{}\" \"{}\" %*\r\nset \"SNAGLET_EXIT=%errorlevel%\"\r\nchcp %SNAGLET_ORIGINAL_CODEPAGE% >nul\r\nexit /b %SNAGLET_EXIT%\r\n",
        snaglet_home.to_string_lossy().replace('%', "%%"),
        node.to_string_lossy().replace('%', "%%"),
        cli.to_string_lossy().replace('%', "%%"),
    )
}

fn cli_resource(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|dir| dir.join("cli").join("bin").join("snaglet.mjs"))
        .map_err(|err| format!("Cannot resolve Snaglet resources: {err}"))
}

fn current_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, String), String> {
    let node = crate::sidecar::external_process_path(
        &crate::sidecar::node_binary(),
        "bundled Node executable",
    )?;
    let cli = crate::sidecar::external_process_path(&cli_resource(app)?, "bundled Snaglet CLI")?;
    let snaglet_home =
        crate::sidecar::external_process_path(&crate::sidecar::data_dir()?, "Snaglet home")?;
    let contents = launcher_contents(&node, &cli, &snaglet_home);
    Ok((node, cli, contents))
}

fn bin_is_on_path(bin: &Path) -> bool {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).any(|entry| path_matches(&entry, bin)))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn publish_launcher(temporary: &Path, launcher: &Path) -> Result<(), String> {
    std::fs::rename(temporary, launcher)
        .map_err(|err| format!("Cannot install {}: {err}", launcher.display()))
}

#[cfg(not(target_os = "windows"))]
fn publish_launcher(temporary: &Path, launcher: &Path) -> Result<(), String> {
    std::fs::rename(temporary, launcher)
        .map_err(|err| format!("Cannot install {}: {err}", launcher.display()))
}

#[cfg(target_os = "windows")]
fn path_matches(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(target_os = "windows"))]
fn path_matches(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(target_os = "windows")]
fn path_export_command() -> String {
    "set PATH=%LOCALAPPDATA%\\Snaglet\\bin;%PATH%".to_string()
}

#[cfg(not(target_os = "windows"))]
fn path_export_command() -> String {
    "export PATH=\"$HOME/.local/bin:$PATH\"".to_string()
}

pub fn status(app: &tauri::AppHandle) -> Result<CliInstallStatus, String> {
    let launcher = launcher_path()?;
    let bin_dir = launcher
        .parent()
        .ok_or_else(|| "Cannot resolve CLI install directory".to_string())?;
    let (node, cli, expected) = current_paths(app)?;
    let existing = std::fs::read_to_string(&launcher).ok();
    let installed = existing.is_some();
    let current = existing.as_deref() == Some(expected.as_str());
    let conflict = existing
        .as_deref()
        .map(|body| !body.contains(LAUNCHER_MARKER))
        .unwrap_or(false);
    Ok(CliInstallStatus {
        available: node.is_file() && cli.is_file(),
        installed,
        current,
        conflict,
        launcher_path: launcher.to_string_lossy().into_owned(),
        cli_path: cli.to_string_lossy().into_owned(),
        path_configured: bin_is_on_path(bin_dir),
        path_export_command: path_export_command(),
    })
}

pub fn install(app: &tauri::AppHandle) -> Result<CliInstallStatus, String> {
    let before = status(app)?;
    if !before.available {
        return Err("The Snaglet CLI is not bundled in this app build".to_string());
    }
    if before.conflict {
        return Err(format!(
            "{} already exists and is not managed by Snaglet",
            before.launcher_path
        ));
    }
    let launcher = PathBuf::from(&before.launcher_path);
    let parent = launcher
        .parent()
        .ok_or_else(|| "Cannot resolve CLI install directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot create {}: {err}", parent.display()))?;
    let (_, _, contents) = current_paths(app)?;
    let temporary = parent.join(format!(".snaglet.{}.tmp", std::process::id()));
    std::fs::write(&temporary, contents)
        .map_err(|err| format!("Cannot write CLI launcher: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))
            .map_err(|err| format!("Cannot make CLI launcher executable: {err}"))?;
    }
    publish_launcher(&temporary, &launcher)?;
    if let Ok(marker) = opt_out_marker(app) {
        let _ = std::fs::remove_file(marker);
    }
    status(app)
}

/// Marker written when the user removes the CLI, so boot stops reinstalling it.
/// Lives in the app's config dir, not the Snaglet home, so it survives a home move.
fn opt_out_marker(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("cli-auto-install-disabled"))
        .map_err(|err| format!("Cannot resolve Snaglet config dir: {err}"))
}

/// What boot should do with the launcher, given its status and the opt-out.
#[derive(Debug, PartialEq)]
enum AutoAction {
    Install,
    Skip(&'static str),
}

fn auto_action(status: &CliInstallStatus, opted_out: bool) -> AutoAction {
    if !status.available {
        AutoAction::Skip("CLI not bundled in this build")
    } else if status.conflict {
        AutoAction::Skip("an unmanaged snaglet executable is already there")
    } else if status.current {
        AutoAction::Skip("launcher already current")
    } else if opted_out && !status.installed {
        AutoAction::Skip("user removed the CLI")
    } else {
        // Missing, or managed but stale (app moved, Snaglet home changed).
        AutoAction::Install
    }
}

/// Packaged boot: install the launcher, or refresh a stale managed one. Never
/// touches a file Snaglet doesn't own, and respects an earlier uninstall.
pub fn ensure_installed(app: &tauri::AppHandle) -> Result<&'static str, String> {
    let before = status(app)?;
    let opted_out = opt_out_marker(app)?.exists();
    match auto_action(&before, opted_out) {
        AutoAction::Skip(reason) => Ok(reason),
        AutoAction::Install => install(app).map(|_| "installed"),
    }
}

pub fn uninstall(app: &tauri::AppHandle) -> Result<CliInstallStatus, String> {
    let before = status(app)?;
    if before.conflict {
        return Err(format!(
            "Refusing to remove unmanaged executable at {}",
            before.launcher_path
        ));
    }
    if before.installed {
        std::fs::remove_file(&before.launcher_path)
            .map_err(|err| format!("Cannot remove {}: {err}", before.launcher_path))?;
    }
    let marker = opt_out_marker(app)?;
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&marker, "")
        .map_err(|err| format!("Cannot record CLI opt-out at {}: {err}", marker.display()))?;
    status(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(available: bool, installed: bool, current: bool, conflict: bool) -> CliInstallStatus {
        CliInstallStatus {
            available,
            installed,
            current,
            conflict,
            launcher_path: String::new(),
            cli_path: String::new(),
            path_configured: true,
            path_export_command: String::new(),
        }
    }

    #[test]
    fn auto_install_decisions() {
        assert_eq!(
            auto_action(&st(true, false, false, false), false),
            AutoAction::Install
        );
        // Stale managed launcher is refreshed even after an opt-out (it's still installed).
        assert_eq!(
            auto_action(&st(true, true, false, false), true),
            AutoAction::Install
        );
        assert!(matches!(
            auto_action(&st(true, true, true, false), false),
            AutoAction::Skip(_)
        ));
        assert!(matches!(
            auto_action(&st(true, true, false, true), false),
            AutoAction::Skip(_)
        ));
        assert!(matches!(
            auto_action(&st(false, false, false, false), false),
            AutoAction::Skip(_)
        ));
        assert!(matches!(
            auto_action(&st(true, false, false, false), true),
            AutoAction::Skip(_)
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn launcher_quotes_paths_and_forwards_arguments() {
        let body = launcher_contents(
            Path::new("/Applications/Snaglet's Build/Snaglet.app/snaglet-node"),
            Path::new("/Applications/Snaglet's Build/Snaglet.app/cli/bin/snaglet.mjs"),
            Path::new("/Users/test/Snaglet's data"),
        );
        assert!(body.contains(LAUNCHER_MARKER));
        assert!(body.contains("Snaglet'\\''s Build"));
        assert!(body.contains("export SNAGLET_HOME='/Users/test/Snaglet'\\''s data'"));
        assert!(body.ends_with(" \"$@\"\n"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn launcher_uses_cmd_syntax_and_preserves_percent_paths() {
        let body = launcher_contents(
            Path::new(r"C:\Program Files\Snaglet 100%\snaglet-node.exe"),
            Path::new(r"C:\Program Files\Snaglet 100%\cli\snaglet.mjs"),
            Path::new(r"C:\Users\Test User\Snaglet 100%"),
        );
        assert!(body.contains("set \"SNAGLET_HOME=C:\\Users\\Test User\\Snaglet 100%%\""));
        assert!(body.contains("\"C:\\Program Files\\Snaglet 100%%\\snaglet-node.exe\""));
        assert!(body.contains("setlocal DisableDelayedExpansion"));
        assert!(body.contains("for /f \"tokens=2 delims=:\" %%A in ('chcp')"));
        assert!(body.contains("chcp 65001 >nul"));
        assert!(
            body.ends_with("chcp %SNAGLET_ORIGINAL_CODEPAGE% >nul\r\nexit /b %SNAGLET_EXIT%\r\n")
        );
    }
}
