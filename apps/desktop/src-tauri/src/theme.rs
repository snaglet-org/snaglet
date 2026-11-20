//! Snaglet's default color theme (Soft Pastel Garden) for the native windows.
//!
//! Read at compile time from the @snaglet/theme package's generated
//! `defaultTheme.json`, the same palette the app's stylesheet ships, so the
//! splash and the app window open in the app's own colors instead of white.

use serde_json::{Map, Value};
use std::sync::OnceLock;

const DEFAULT_THEME_JSON: &str = include_str!("../../../../packages/theme/defaultTheme.json");

fn palette() -> &'static Map<String, Value> {
    static PALETTE: OnceLock<Map<String, Value>> = OnceLock::new();
    PALETTE.get_or_init(|| {
        serde_json::from_str(DEFAULT_THEME_JSON)
            .expect("packages/theme/defaultTheme.json is a JSON object")
    })
}

/// A default theme color as `#rrggbb`, by its token key (`background`, `text`, …).
pub(crate) fn hex(key: &str) -> &'static str {
    palette()
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("the default theme has no {key} color"))
}

fn rgb(hex: &str) -> (u8, u8, u8) {
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).expect("a #rrggbb color");
    (channel(1), channel(3), channel(5))
}

/// The app window's background before its page paints: the page canvas the
/// stylesheet paints first (`--disabled`, the `html`/`body` color).
pub(crate) fn window_background() -> tauri::window::Color {
    let (r, g, b) = rgb(hex("disabled"));
    tauri::window::Color(r, g, b, 255)
}

/// The splash window's background: the default theme's page color.
pub(crate) fn splash_background() -> tauri::window::Color {
    let (r, g, b) = rgb(hex("background"));
    tauri::window::Color(r, g, b, 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_default_theme() {
        assert_eq!(hex("background"), "#0a0a0a");
        assert_eq!(hex("text"), "#f5f5f5");
        assert_eq!(hex("text-muted"), "#a1a1a1");
        assert_eq!(hex("disabled"), "#2a2a2a");
    }

    #[test]
    fn converts_hex_to_an_opaque_window_color() {
        let tauri::window::Color(r, g, b, a) = window_background();
        assert_eq!((r, g, b, a), (0x2a, 0x2a, 0x2a, 255));
        let tauri::window::Color(r, g, b, a) = splash_background();
        assert_eq!((r, g, b, a), (0x0a, 0x0a, 0x0a, 255));
    }
}
