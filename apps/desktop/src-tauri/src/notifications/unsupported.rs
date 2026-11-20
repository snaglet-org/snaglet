//! Windows and Linux: no native reminder notifications yet. Every call
//! reports `supported: false` so the UI relies on its in-app banner. A real
//! backend replaces this module per platform with the same functions.

use super::{NativeNotificationStatus, PlannedBanner, PlannedNotification};

pub(super) fn install() {}

pub(super) fn status() -> NativeNotificationStatus {
    NativeNotificationStatus::unsupported()
}

pub(super) fn request_permission() -> NativeNotificationStatus {
    NativeNotificationStatus::unsupported()
}

/// `None`: nothing can be scheduled on this platform.
pub(super) fn replace_pending(
    _planned: &[PlannedNotification],
    _now_ms: i64,
) -> Option<(usize, usize)> {
    None
}

pub(super) fn cancel_all() {}

/// `None`: no native banners on this platform; the page falls back.
pub(super) fn show_now(_banner: &PlannedBanner) -> Option<bool> {
    None
}

pub(super) fn close_delivered(_identifier: &str) {}
