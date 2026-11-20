//! The small "Starting Snaglet…" window shown while the sidecar boots.
//!
//! The page is static HTML served from a private URI scheme, so it needs
//! neither the server (not up yet) nor the bundled UI. Status text is pushed
//! in with `eval`; the page has no script of its own and cannot navigate.

use crate::sidecar::{BootObserver, BootPhase};
use crate::theme;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::Manager;

pub(crate) const LABEL: &str = "splash";
pub(crate) const SCHEME: &str = "snagletsplash";

/// After this long, a plain start gets a reassurance line; a slow boot is
/// allowed to run past it.
pub(crate) const SLOW_BOOT_NOTICE: Duration = Duration::from_secs(90);
const RESEND_INTERVAL: Duration = Duration::from_secs(5);

const KEEP_WAITING: &str = "Keep Waiting";
const QUIT: &str = "Quit Snaglet";

// The colors are the default theme's background, text and text muted
// (packages/theme, Soft Pastel Garden, filled in by `page`), so launch opens in
// the palette the app paints. The default theme is dark whatever the system's
// light or dark setting, so the splash is too.
const PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Snaglet</title>
<style>
:root { color-scheme: dark; --bg: __BG__; --fg: __FG__; --muted: __MUTED__; --track: color-mix(in srgb, var(--fg) 16%, transparent); }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); cursor: default;
  font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-user-select: none; user-select: none; }
main { box-sizing: border-box; height: 100%; padding: 0 32px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; text-align: center; }
.spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--track);
  border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
#status { font-size: 15px; font-weight: 600; }
#detail { min-height: 3em; max-width: 360px; color: var(--muted); font-size: 12.5px; line-height: 1.45; }
</style>
</head>
<body>
<main>
<div class="spinner" aria-hidden="true"></div>
<div id="status" role="status" aria-live="polite">__STATUS__</div>
<div id="detail"></div>
</main>
</body>
</html>
"#;

pub(crate) fn page(app_name: &str) -> Vec<u8> {
    PAGE.replace("__BG__", theme::hex("background"))
        .replace("__FG__", theme::hex("text"))
        .replace("__MUTED__", theme::hex("text-muted"))
        .replace("__STATUS__", &starting_status(app_name))
        .into_bytes()
}

fn starting_status(app_name: &str) -> String {
    format!("Starting {app_name}…")
}

pub(crate) fn url() -> tauri::Url {
    // WebView2 exposes custom schemes as http://<scheme>.localhost.
    #[cfg(target_os = "windows")]
    let raw = format!("http://{SCHEME}.localhost/");
    #[cfg(not(target_os = "windows"))]
    let raw = format!("{SCHEME}://localhost/");
    raw.parse().expect("static splash URL")
}

pub(crate) fn open(app: &tauri::AppHandle, app_name: &str) -> tauri::Result<()> {
    let home = url();
    tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::CustomProtocol(url()))
        .title(app_name)
        .background_color(theme::splash_background())
        .inner_size(440.0, 240.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .on_navigation(move |target| {
            target.scheme() == home.scheme() && target.host_str() == home.host_str()
        })
        .build()?;
    Ok(())
}

pub(crate) fn close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SplashText {
    pub status: String,
    pub detail: String,
}

pub(crate) fn splash_text(app_name: &str, phase: BootPhase, elapsed: Duration) -> SplashText {
    match phase {
        BootPhase::UpgradingDatabase => SplashText {
            status: "Upgrading your database…".into(),
            detail: format!(
                "{app_name} is backing up your data and updating it for this version. \
                 Large databases can take several minutes — keep {app_name} open until it finishes."
            ),
        },
        BootPhase::Starting if elapsed >= SLOW_BOOT_NOTICE => SplashText {
            status: starting_status(app_name),
            detail: format!(
                "This is taking longer than usual, but {app_name} is still working. Keep it open."
            ),
        },
        BootPhase::Starting => SplashText {
            status: starting_status(app_name),
            detail: String::new(),
        },
    }
}

pub(crate) fn stall_description(
    app_name: &str,
    phase: BootPhase,
    stalled_for: Duration,
    logs_dir: &std::path::Path,
) -> String {
    let activity = match phase {
        BootPhase::UpgradingDatabase => "upgrading your database",
        BootPhase::Starting => "starting",
    };
    format!(
        "{app_name} has been {activity} with no new activity for {} minutes. It may still be working.\n\n\
         Keep waiting, or quit? Quitting interrupts startup, which runs again the next time you open {app_name}.\n\n\
         Logs: {}",
        stalled_for.as_secs() / 60,
        logs_dir.display()
    )
}

/// Drives the splash window from `sidecar::wait_until_ready`.
pub(crate) struct SplashProgress {
    app: tauri::AppHandle,
    app_name: &'static str,
    logs_dir: PathBuf,
    shown: Option<SplashText>,
    last_sent: Instant,
}

impl SplashProgress {
    pub(crate) fn new(app: tauri::AppHandle, app_name: &'static str, logs_dir: PathBuf) -> Self {
        Self {
            app,
            app_name,
            logs_dir,
            shown: None,
            last_sent: Instant::now(),
        }
    }

    fn render(&mut self, text: SplashText) {
        let Some(window) = self.app.get_webview_window(LABEL) else {
            return;
        };
        let script = format!(
            "(function(s,d){{var a=document.getElementById('status'),b=document.getElementById('detail');if(a)a.textContent=s;if(b)b.textContent=d;}})({},{});",
            serde_json::to_string(&text.status).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&text.detail).unwrap_or_else(|_| "\"\"".into()),
        );
        let _ = window.eval(script);
        self.shown = Some(text);
        self.last_sent = Instant::now();
    }
}

impl BootObserver for SplashProgress {
    fn progress(&mut self, phase: BootPhase, elapsed: Duration) {
        let text = splash_text(self.app_name, phase, elapsed);
        // Re-sending now and then covers an update that landed before the
        // page finished loading.
        if self.shown.as_ref() != Some(&text) || self.last_sent.elapsed() >= RESEND_INTERVAL {
            self.render(text);
        }
    }

    fn keep_waiting(&mut self, phase: BootPhase, stalled_for: Duration) -> bool {
        use rfd::{MessageButtons, MessageDialog, MessageLevel};
        let choice = MessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title(format!("{} is taking a long time to start", self.app_name))
            .set_description(stall_description(
                self.app_name,
                phase,
                stalled_for,
                &self.logs_dir,
            ))
            .set_buttons(MessageButtons::OkCancelCustom(
                KEEP_WAITING.into(),
                QUIT.into(),
            ))
            .show();
        // Dismissing the dialog keeps waiting: interrupting an upgrade must be
        // an explicit choice.
        crate::dialog_choice(&choice, &[KEEP_WAITING, QUIT]) != Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splash_explains_upgrades_and_slow_starts() {
        let quick = splash_text("Snaglet", BootPhase::Starting, Duration::from_secs(3));
        assert_eq!(quick.status, "Starting Snaglet…");
        assert!(quick.detail.is_empty());

        let slow = splash_text("Snaglet", BootPhase::Starting, SLOW_BOOT_NOTICE);
        assert_eq!(slow.status, "Starting Snaglet…");
        assert!(slow.detail.contains("still working"));

        let upgrade = splash_text("Snaglet", BootPhase::UpgradingDatabase, Duration::ZERO);
        assert_eq!(upgrade.status, "Upgrading your database…");
        assert!(upgrade.detail.contains("keep Snaglet open"));
    }

    #[test]
    fn splash_page_starts_with_the_app_name() {
        let html = String::from_utf8(page("Snaglet Preview")).expect("utf8 page");
        assert!(html.contains(">Starting Snaglet Preview…<"));
        assert!(!html.contains("__STATUS__"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn splash_page_paints_the_default_theme() {
        let html = String::from_utf8(page("Snaglet")).expect("utf8 page");
        assert!(html.contains("--bg: #0a0a0a; --fg: #f5f5f5; --muted: #a1a1a1;"));
        assert!(html.contains("color-scheme: dark;"));
        assert!(
            !html.contains("__BG__") && !html.contains("__FG__") && !html.contains("__MUTED__")
        );
    }

    #[test]
    fn stall_prompt_names_the_activity_and_log() {
        let text = stall_description(
            "Snaglet",
            BootPhase::UpgradingDatabase,
            Duration::from_secs(15 * 60),
            std::path::Path::new("/tmp/snaglet-test/logs"),
        );
        assert!(text.contains("upgrading your database"));
        assert!(text.contains("15 minutes"));
        assert!(text.contains("Logs: /tmp/snaglet-test/logs"));
    }
}
