//! Where links clicked inside the app window may go.
//!
//! The main webview only ever shows the Snaglet UI origin (the sidecar's loopback
//! origin in a packaged build, the Vite dev server in development). WebKit
//! gives an app webview no browser chrome and silently drops `target="_blank"`
//! and `window.open` requests, so external web links are handed to the
//! system browser instead, and anything else is refused.

use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LinkDecision {
    /// Load inside the app window.
    Stay,
    /// Hand to the system browser (or mail client) and keep the app in place.
    OpenExternally,
    /// Refuse without opening anything.
    Block,
}

/// Schemes the operating system may open on Snaglet's behalf.
pub(crate) fn is_external_link(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str().is_some_and(|host| !host.is_empty()),
        "mailto" => true,
        _ => false,
    }
}

fn is_app_origin(app_origin: &Url, target: &Url) -> bool {
    target.scheme() == app_origin.scheme() && target.origin() == app_origin.origin()
}

/// A navigation of the app webview itself (a plain link, a redirect, a
/// reload). Same-origin pages stay; external web links leave for the browser.
pub(crate) fn navigation_decision(app_origin: &Url, target: &Url) -> LinkDecision {
    if is_app_origin(app_origin, target) {
        return LinkDecision::Stay;
    }
    if target.scheme() == "about" && matches!(target.path(), "blank" | "srcdoc") {
        return LinkDecision::Stay;
    }
    if is_external_link(target) {
        LinkDecision::OpenExternally
    } else {
        LinkDecision::Block
    }
}

/// A `target="_blank"` link or `window.open` call. Snaglet never opens a second app
/// window, so even a same-origin request is refused.
pub(crate) fn new_window_decision(app_origin: &Url, target: &Url) -> LinkDecision {
    if is_app_origin(app_origin, target) {
        return LinkDecision::Block;
    }
    if is_external_link(target) {
        LinkDecision::OpenExternally
    } else {
        LinkDecision::Block
    }
}

pub(crate) fn open_external(url: &Url) -> Result<(), String> {
    if !is_external_link(url) {
        return Err(format!(
            "Snaglet only opens web and mail links outside the app, not {}: links",
            url.scheme()
        ));
    }
    open::that_detached(url.as_str()).map_err(|error| format!("Failed to open URL: {error}"))
}

fn apply(decision: LinkDecision, target: &Url) -> bool {
    match decision {
        LinkDecision::Stay => true,
        LinkDecision::OpenExternally => {
            if let Err(error) = open_external(target) {
                eprintln!("[shell] {error}");
            }
            false
        }
        LinkDecision::Block => {
            eprintln!("[shell] blocked navigation to {}", target.scheme());
            false
        }
    }
}

/// `on_navigation` handler: true lets the app webview load `target`.
pub(crate) fn handle_navigation(app_origin: &Url, target: &Url) -> bool {
    apply(navigation_decision(app_origin, target), target)
}

/// `on_new_window` handler body; the caller always denies the new window.
pub(crate) fn handle_new_window(app_origin: &Url, target: &Url) {
    apply(new_window_decision(app_origin, target), target);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url")
    }

    #[test]
    fn app_origin_navigation_stays_and_web_links_leave() {
        let app = url("http://127.0.0.1:4123/");
        assert_eq!(
            navigation_decision(&app, &url("http://127.0.0.1:4123/dashboard?x=1#y")),
            LinkDecision::Stay
        );
        assert_eq!(
            navigation_decision(&app, &url("https://example.com/docs")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            navigation_decision(&app, &url("http://example.com")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            navigation_decision(&app, &url("mailto:user@example.com")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            navigation_decision(&app, &url("about:blank")),
            LinkDecision::Stay
        );
    }

    #[test]
    fn other_loopback_origins_are_not_the_app() {
        let app = url("http://127.0.0.1:4123/");
        assert_eq!(
            navigation_decision(&app, &url("http://127.0.0.1:9999/")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            navigation_decision(&app, &url("http://localhost:4123/")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            navigation_decision(&app, &url("https://127.0.0.1:4123/")),
            LinkDecision::OpenExternally
        );
    }

    #[test]
    fn non_web_schemes_are_blocked() {
        let app = url("http://127.0.0.1:4123/");
        for raw in [
            "file:///etc/hosts",
            "blob:http://127.0.0.1:4123/1111-aaaa",
            "data:text/html,hello",
            "javascript:alert(1)",
            "vscode://file/tmp/example",
            "ftp://example.com/file",
        ] {
            assert_eq!(
                navigation_decision(&app, &url(raw)),
                LinkDecision::Block,
                "{raw}"
            );
            assert_eq!(
                new_window_decision(&app, &url(raw)),
                LinkDecision::Block,
                "{raw}"
            );
        }
    }

    #[test]
    fn new_windows_open_web_links_externally_and_never_the_app() {
        let app = url("http://localhost:3000/");
        assert_eq!(
            new_window_decision(&app, &url("https://github.com/login/device")),
            LinkDecision::OpenExternally
        );
        assert_eq!(
            new_window_decision(&app, &url("http://localhost:3000/other")),
            LinkDecision::Block
        );
        assert_eq!(
            new_window_decision(&app, &url("about:blank")),
            LinkDecision::Block
        );
    }

    #[test]
    fn open_external_refuses_non_web_schemes() {
        assert!(open_external(&url("file:///Applications/Calculator.app")).is_err());
        assert!(open_external(&url("smb://server/share")).is_err());
    }
}
