//! Native OS notifications for calendar reminders.
//!
//! The desktop UI fetches the reminders firing in the next window from the
//! server and hands them to `notifications_sync`, which replaces every
//! notification Snaglet has pending with these, scheduled ahead in the OS so they
//! fire on time even while Snaglet is quit. Clicking a delivered one brings Snaglet to
//! the front and emits [`CLICK_EVENT`] with `{ key, item }`.
//!
//! The same backend also delivers immediate banners for run alerts, mentions
//! and tool approvals (`notifications_show` / `notifications_close`): the
//! packaged UI's WKWebView has no usable Web Notification API, so the page
//! hands those to the shell instead. A click emits [`BANNER_CLICK_EVENT`] with
//! the notification's id.
//!
//! Contract: `packages/shared/types/reminders.ts` (`ReminderDue`,
//! `NativeNotificationStatus`). macOS is implemented in `macos.rs`; every
//! other platform reports `supported: false` from `unsupported.rs`, so the
//! in-app banner carries reminders alone there until a backend is added.
//!
//! Commands never fail on a platform problem: they answer with a status (or
//! zero scheduled) instead, and nothing here panics on bad input.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(not(target_os = "macos"))]
mod unsupported;
#[cfg(not(target_os = "macos"))]
use unsupported as backend;

/// Tauri event emitted to the UI when the user clicks a delivered reminder.
pub const CLICK_EVENT: &str = "reminder-notification-clicked";

/// Tauri event emitted to the UI when the user clicks an immediate banner
/// shown through `notifications_show`; the payload is a [`BannerClick`].
pub const BANNER_CLICK_EVENT: &str = "banner-notification-clicked";

/// macOS keeps at most 64 pending requests per app and silently drops the
/// rest; Snaglet schedules only the nearest 60, and the UI re-syncs as time passes.
pub const MAX_SCHEDULED: usize = 60;

/// userInfo keys carried by each notification so a click can name its item.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const USER_INFO_KEY: &str = "snagletReminderKey";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const USER_INFO_ITEM: &str = "snagletReminderItem";

/// userInfo key carried by an immediate banner so a click can name it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const USER_INFO_BANNER_ID: &str = "snagletBannerId";

/// OS identifier prefix of immediate banners, so they can never collide with
/// a scheduled reminder (identified by its bare key).
const BANNER_IDENTIFIER_PREFIX: &str = "snaglet-banner:";

/// Built-in reminder sounds (`REMINDER_SOUNDS` minus `none`), bundled as
/// `Contents/Resources/<id>.wav` through `bundle.macOS.files` in
/// tauri.conf.json, where `UNNotificationSound soundNamed:` finds them.
pub(crate) const BUNDLED_SOUNDS: [&str; 5] = ["chime", "bell", "ping", "pulse", "marimba"];

const MAIN_WINDOW: &str = "main";

// Contract types

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationPlatform {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum NotificationPermission {
    Granted,
    Denied,
    Unknown,
}

/// `NativeNotificationStatus` in reminders.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotificationStatus {
    platform: NotificationPlatform,
    /// This platform has a working native implementation in this process.
    supported: bool,
    permission: NotificationPermission,
    /// The OS holds notifications scheduled ahead (they fire while Snaglet is quit).
    can_schedule: bool,
}

impl NativeNotificationStatus {
    pub(crate) fn unsupported() -> Self {
        Self {
            platform: current_platform(),
            supported: false,
            permission: NotificationPermission::Unknown,
            can_schedule: false,
        }
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn supported(permission: NotificationPermission) -> Self {
        Self {
            platform: current_platform(),
            supported: true,
            permission,
            can_schedule: true,
        }
    }
}

fn current_platform() -> NotificationPlatform {
    if cfg!(target_os = "macos") {
        NotificationPlatform::Macos
    } else if cfg!(target_os = "windows") {
        NotificationPlatform::Windows
    } else {
        NotificationPlatform::Linux
    }
}

/// `ReminderOffset` in reminders.ts: "[amount] [unit] before" the start.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReminderOffset {
    pub amount: u64,
    /// `minutes` | `hours` | `days`.
    pub unit: String,
}

/// `ReminderDue` in reminders.ts. `startsAt` is not needed here, so it is
/// not read; `item` is kept verbatim and handed back on click.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderDue {
    pub key: String,
    pub item: serde_json::Value,
    pub title: String,
    #[serde(default)]
    pub calendar_name: Option<String>,
    pub fire_at: String,
    #[serde(default)]
    pub offset: Option<ReminderOffset>,
    pub sound: String,
}

/// Payload of [`CLICK_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReminderClick {
    pub key: String,
    pub item: serde_json::Value,
}

/// Payload of [`BANNER_CLICK_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BannerClick {
    pub id: String,
}

/// What `notifications_sync` reports back.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSyncResult {
    /// Accepted by the OS.
    pub scheduled: usize,
    /// Not scheduled: already past, unparseable, duplicate key, beyond the
    /// nearest 60, or the platform is unsupported.
    pub skipped: usize,
    /// Refused by the OS (e.g. permission denied) or unconfirmed.
    pub failed: usize,
}

// Pure planning (unit-tested)

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum NotificationSound {
    Silent,
    /// A bundled file name, e.g. `chime.wav`.
    Bundled(String),
    SystemDefault,
}

/// One notification, ready for the platform backend.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct PlannedNotification {
    pub key: String,
    pub fire_at_ms: i64,
    pub title: String,
    pub body: String,
    pub sound: NotificationSound,
    /// `item` as JSON, stored in userInfo under [`USER_INFO_ITEM`].
    pub item_json: String,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Milliseconds since the epoch for an ISO 8601 / RFC 3339 instant.
pub(crate) fn parse_instant_ms(iso: &str) -> Option<i64> {
    let at =
        time::OffsetDateTime::parse(iso.trim(), &time::format_description::well_known::Rfc3339)
            .ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// "Starts in 15 minutes · Work", "Starting now · Work", or without the
/// calendar when it has no name.
pub(crate) fn body_text(offset: Option<&ReminderOffset>, calendar_name: Option<&str>) -> String {
    let lead = match offset {
        Some(offset) if offset.amount > 0 => {
            let one = offset.amount == 1;
            let unit = match offset.unit.as_str() {
                "days" if one => "day",
                "days" => "days",
                "hours" if one => "hour",
                "hours" => "hours",
                _ if one => "minute",
                _ => "minutes",
            };
            format!("Starts in {} {unit}", offset.amount)
        }
        _ => "Starting now".to_string(),
    };
    match calendar_name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{lead} · {name}"),
        None => lead,
    }
}

/// `none` is silent; a built-in id plays its bundled WAV; anything else falls
/// back to the system sound rather than failing.
pub(crate) fn sound_for(id: &str) -> NotificationSound {
    match id {
        "none" => NotificationSound::Silent,
        id if BUNDLED_SOUNDS.contains(&id) => NotificationSound::Bundled(format!("{id}.wav")),
        _ => NotificationSound::SystemDefault,
    }
}

/// One immediate banner, ready for the platform backend.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct PlannedBanner {
    /// The in-app notification id; handed back in [`BannerClick`].
    pub id: String,
    /// The OS request identifier: a banner with the same one replaces the
    /// earlier (so `tag` collapses banners of one kind).
    pub identifier: String,
    pub title: String,
    pub body: String,
    pub sound: NotificationSound,
}

/// OS identifier for the banner tagged `tag`.
pub(crate) fn banner_identifier(tag: &str) -> String {
    format!("{BANNER_IDENTIFIER_PREFIX}{}", tag.trim())
}

/// Plan an immediate banner. `None` when `id` is blank (a click could not
/// name it). The tag defaults to the id; the sound defaults to the system
/// one (`none` is silent, a built-in reminder sound id plays its WAV).
pub(crate) fn plan_banner(
    id: &str,
    title: &str,
    body: Option<&str>,
    sound: Option<&str>,
    tag: Option<&str>,
) -> Option<PlannedBanner> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let title = title.trim();
    let tag = tag
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .unwrap_or(id);
    Some(PlannedBanner {
        id: id.to_string(),
        identifier: banner_identifier(tag),
        title: if title.is_empty() { "Snaglet" } else { title }.to_string(),
        body: body.map(str::trim).unwrap_or_default().to_string(),
        sound: sound_for(sound.map(str::trim).unwrap_or("default")),
    })
}

/// The notifications to schedule: future ones only, one per key (the
/// earliest), nearest first, at most [`MAX_SCHEDULED`].
pub(crate) fn plan(reminders: &[ReminderDue], now_ms: i64) -> Vec<PlannedNotification> {
    let mut upcoming: Vec<(i64, &ReminderDue)> = reminders
        .iter()
        .filter(|reminder| !reminder.key.trim().is_empty())
        .filter_map(|reminder| Some((parse_instant_ms(&reminder.fire_at)?, reminder)))
        .filter(|(fire_at_ms, _)| *fire_at_ms > now_ms)
        .collect();
    upcoming.sort_by(|(left_at, left), (right_at, right)| {
        left_at.cmp(right_at).then_with(|| left.key.cmp(&right.key))
    });
    let mut seen = HashSet::new();
    upcoming.retain(|(_, reminder)| seen.insert(reminder.key.as_str()));
    upcoming.truncate(MAX_SCHEDULED);
    upcoming
        .into_iter()
        .map(|(fire_at_ms, reminder)| {
            let title = reminder.title.trim();
            PlannedNotification {
                key: reminder.key.clone(),
                fire_at_ms,
                title: if title.is_empty() { "Reminder" } else { title }.to_string(),
                body: body_text(reminder.offset.as_ref(), reminder.calendar_name.as_deref()),
                sound: sound_for(&reminder.sound),
                item_json: serde_json::to_string(&reminder.item)
                    .unwrap_or_else(|_| "null".to_string()),
            }
        })
        .collect()
}

/// Rebuild a click from a notification's userInfo. Notifications without a
/// reminder key are not Snaglet reminders and are ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn click_from_user_info(
    key: Option<String>,
    item_json: Option<String>,
) -> Option<ReminderClick> {
    let key = key.filter(|key| !key.trim().is_empty())?;
    let item = item_json
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or(serde_json::Value::Null);
    Some(ReminderClick { key, item })
}

/// Rebuild an immediate banner's click from its userInfo id.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn banner_click_from_user_info(id: Option<String>) -> Option<BannerClick> {
    let id = id.filter(|id| !id.trim().is_empty())?;
    Some(BannerClick { id })
}

// Click delivery

static APP: OnceLock<AppHandle> = OnceLock::new();

/// A click that arrived before the Snaglet window existed — typically the click
/// that launched Snaglet from quit. The UI collects it with
/// `notifications_take_clicked` once it is listening.
static PENDING_CLICK: Mutex<Option<ReminderClick>> = Mutex::new(None);

/// Wire the platform backend. Call from `setup`, which runs inside
/// `applicationDidFinishLaunching`: macOS only hands the click that launched
/// the app to a delegate installed before launching finishes.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    backend::install();
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn deliver_click(click: ReminderClick) {
    let Some(app) = APP.get() else {
        return stash_click(click);
    };
    bring_to_front(app);
    if app.get_webview_window(MAIN_WINDOW).is_none() || app.emit(CLICK_EVENT, &click).is_err() {
        stash_click(click);
    }
}

/// A click on an immediate banner: bring Snaglet forward and tell the page which
/// one. Nothing is stashed — the page's click handlers die with the page, so
/// a click that launches Snaglet from quit can only focus it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn deliver_banner_click(click: BannerClick) {
    let Some(app) = APP.get() else {
        return;
    };
    bring_to_front(app);
    if app.get_webview_window(MAIN_WINDOW).is_some() {
        let _ = app.emit(BANNER_CLICK_EVENT, &click);
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn stash_click(click: ReminderClick) {
    if let Ok(mut pending) = PENDING_CLICK.lock() {
        *pending = Some(click);
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bring_to_front(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .or_else(|| app.get_webview_window(crate::splash::LABEL));
    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Commands
//
// Async + spawn_blocking: the backend waits on OS completion handlers (the
// permission prompt can take as long as the user does), which must not hold
// the main thread.

async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

#[tauri::command]
pub async fn notifications_status() -> NativeNotificationStatus {
    off_main_thread(backend::status)
        .await
        .unwrap_or_else(NativeNotificationStatus::unsupported)
}

/// Shows the OS permission prompt the first time; afterward just reports.
#[tauri::command]
pub async fn notifications_request_permission() -> NativeNotificationStatus {
    off_main_thread(backend::request_permission)
        .await
        .unwrap_or_else(NativeNotificationStatus::unsupported)
}

/// Replace every pending Snaglet notification with `reminders`.
#[tauri::command]
pub async fn notifications_sync(reminders: Vec<ReminderDue>) -> NotificationSyncResult {
    let total = reminders.len();
    off_main_thread(move || {
        let now = now_ms();
        let planned = plan(&reminders, now);
        match backend::replace_pending(&planned, now) {
            Some((scheduled, failed)) => NotificationSyncResult {
                scheduled,
                skipped: total - planned.len(),
                failed,
            },
            None => NotificationSyncResult {
                skipped: total,
                ..NotificationSyncResult::default()
            },
        }
    })
    .await
    .unwrap_or(NotificationSyncResult {
        failed: total,
        ..NotificationSyncResult::default()
    })
}

/// Remove every pending Snaglet notification (delivered ones stay in Notification Center).
#[tauri::command]
pub async fn notifications_cancel_all() {
    let _ = off_main_thread(backend::cancel_all).await;
}

/// Show one banner now (run alert, mention, tool approval, failure). `true`
/// when the OS accepted it; `false` when it refused (permission off), the
/// platform has no backend, or the input was unusable — the page then keeps
/// its own fallback (Web Notification API or the in-app sound). A banner
/// sharing `tag` replaces the earlier one.
#[tauri::command]
pub async fn notifications_show(
    id: String,
    title: String,
    body: Option<String>,
    sound: Option<String>,
    tag: Option<String>,
) -> bool {
    let Some(banner) = plan_banner(
        &id,
        &title,
        body.as_deref(),
        sound.as_deref(),
        tag.as_deref(),
    ) else {
        return false;
    };
    off_main_thread(move || backend::show_now(&banner))
        .await
        .flatten()
        .unwrap_or(false)
}

/// Remove the delivered banner shown for `id` (an ask that settled).
#[tauri::command]
pub async fn notifications_close(id: String) {
    let identifier = banner_identifier(&id);
    let _ = off_main_thread(move || backend::close_delivered(&identifier)).await;
}

/// The click that arrived before the window could hear [`CLICK_EVENT`]
/// (Snaglet launched by clicking a reminder), once; `null` otherwise.
#[tauri::command]
pub fn notifications_take_clicked() -> Option<ReminderClick> {
    PENDING_CLICK.lock().ok()?.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-10-15T12:00:00.000Z";

    fn now() -> i64 {
        parse_instant_ms(NOW).unwrap()
    }

    fn due(key: &str, fire_at: &str) -> ReminderDue {
        serde_json::from_value(json!({
            "key": key,
            "item": { "kind": "event", "eventId": "event-1111" },
            "title": "Planning review",
            "calendarName": "Work",
            "startsAt": "2026-10-15T13:00:00.000Z",
            "fireAt": fire_at,
            "offset": { "amount": 15, "unit": "minutes" },
            "sound": "chime"
        }))
        .unwrap()
    }

    fn offset(amount: u64, unit: &str) -> ReminderOffset {
        ReminderOffset {
            amount,
            unit: unit.to_string(),
        }
    }

    #[test]
    fn status_serializes_to_the_shared_contract() {
        let status = NativeNotificationStatus {
            platform: NotificationPlatform::Macos,
            supported: true,
            permission: NotificationPermission::Granted,
            can_schedule: true,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "platform": "macos", "supported": true, "permission": "granted", "canSchedule": true })
        );
        let unsupported = serde_json::to_value(NativeNotificationStatus::unsupported()).unwrap();
        assert_eq!(unsupported["supported"], json!(false));
        assert_eq!(unsupported["permission"], json!("unknown"));
        assert_eq!(unsupported["canSchedule"], json!(false));
    }

    #[test]
    fn body_text_names_the_lead_time_and_calendar() {
        assert_eq!(body_text(None, Some("Work")), "Starting now · Work");
        assert_eq!(body_text(None, None), "Starting now");
        assert_eq!(body_text(None, Some("   ")), "Starting now");
        assert_eq!(
            body_text(Some(&offset(15, "minutes")), Some("Work")),
            "Starts in 15 minutes · Work"
        );
        assert_eq!(
            body_text(Some(&offset(1, "minutes")), None),
            "Starts in 1 minute"
        );
        assert_eq!(
            body_text(Some(&offset(1, "hours")), None),
            "Starts in 1 hour"
        );
        assert_eq!(
            body_text(Some(&offset(2, "hours")), None),
            "Starts in 2 hours"
        );
        assert_eq!(
            body_text(Some(&offset(1, "days")), Some("Home")),
            "Starts in 1 day · Home"
        );
        assert_eq!(
            body_text(Some(&offset(3, "days")), None),
            "Starts in 3 days"
        );
        assert_eq!(body_text(Some(&offset(0, "days")), None), "Starting now");
    }

    #[test]
    fn sounds_map_to_bundled_files_silence_or_the_system_default() {
        for id in BUNDLED_SOUNDS {
            assert_eq!(
                sound_for(id),
                NotificationSound::Bundled(format!("{id}.wav"))
            );
        }
        assert_eq!(sound_for("none"), NotificationSound::Silent);
        assert_eq!(
            sound_for("../../etc/passwd"),
            NotificationSound::SystemDefault
        );
        assert_eq!(sound_for(""), NotificationSound::SystemDefault);
    }

    #[test]
    fn instants_parse_with_millis_offsets_and_reject_garbage() {
        assert_eq!(parse_instant_ms("1970-01-01T00:00:01.500Z"), Some(1_500));
        assert_eq!(
            parse_instant_ms("2026-10-15T14:00:00+02:00"),
            parse_instant_ms("2026-10-15T12:00:00Z")
        );
        assert_eq!(parse_instant_ms("tomorrow"), None);
        assert_eq!(parse_instant_ms(""), None);
    }

    #[test]
    fn plan_skips_past_and_unparseable_reminders() {
        let reminders = vec![
            due("past", "2026-10-15T11:59:59.999Z"),
            due("now", NOW),
            due("bad", "not a date"),
            due("  ", "2026-10-15T12:30:00.000Z"),
            due("future", "2026-10-15T12:00:00.001Z"),
        ];
        let planned = plan(&reminders, now());
        let keys: Vec<_> = planned.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["future"]);
    }

    #[test]
    fn plan_keeps_the_nearest_sixty_in_order_once_per_key() {
        let mut reminders: Vec<ReminderDue> = (0..80)
            .rev()
            .map(|minute| {
                due(
                    &format!("key-{minute:02}"),
                    &format!(
                        "2026-10-15T{:02}:{:02}:00.000Z",
                        13 + minute / 60,
                        minute % 60
                    ),
                )
            })
            .collect();
        // A later duplicate of the nearest key must not take a second slot.
        reminders.push(due("key-00", "2026-10-15T23:00:00.000Z"));
        let planned = plan(&reminders, now());
        assert_eq!(planned.len(), MAX_SCHEDULED);
        assert_eq!(planned[0].key, "key-00");
        assert_eq!(
            planned[0].fire_at_ms,
            parse_instant_ms("2026-10-15T13:00:00Z").unwrap()
        );
        assert_eq!(planned[59].key, "key-59");
        assert!(planned
            .windows(2)
            .all(|pair| pair[0].fire_at_ms <= pair[1].fire_at_ms));
        assert_eq!(planned.iter().filter(|p| p.key == "key-00").count(), 1);
    }

    #[test]
    fn plan_builds_title_body_sound_and_item_json() {
        let mut reminder = due(
            "event-1111:2026-10-15T13:00:00.000Z:15m",
            "2026-10-15T12:45:00.000Z",
        );
        reminder.title = "  ".to_string();
        reminder.sound = "none".to_string();
        let planned = plan(&[reminder], now());
        let only = &planned[0];
        assert_eq!(only.title, "Reminder");
        assert_eq!(only.body, "Starts in 15 minutes · Work");
        assert_eq!(only.sound, NotificationSound::Silent);
        let item: serde_json::Value = serde_json::from_str(&only.item_json).unwrap();
        assert_eq!(item, json!({ "kind": "event", "eventId": "event-1111" }));
    }

    #[test]
    fn at_start_reminders_deserialize_with_a_null_offset_and_calendar() {
        let reminder: ReminderDue = serde_json::from_value(json!({
            "key": "k",
            "item": { "kind": "automation", "automationId": "automation-1111" },
            "title": "Nightly digest",
            "calendarName": null,
            "startsAt": "2026-10-15T13:00:00.000Z",
            "fireAt": "2026-10-15T13:00:00.000Z",
            "offset": null,
            "sound": "bell"
        }))
        .unwrap();
        let planned = plan(&[reminder], now());
        assert_eq!(planned[0].body, "Starting now");
        assert_eq!(
            planned[0].sound,
            NotificationSound::Bundled("bell.wav".to_string())
        );
    }

    #[test]
    fn user_info_round_trips_into_the_click_payload() {
        let planned = plan(&[due("key-1", "2026-10-15T12:45:00.000Z")], now());
        let click = click_from_user_info(
            Some(planned[0].key.clone()),
            Some(planned[0].item_json.clone()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&click).unwrap(),
            json!({ "key": "key-1", "item": { "kind": "event", "eventId": "event-1111" } })
        );
        assert_eq!(click_from_user_info(None, Some("{}".into())), None);
        assert_eq!(click_from_user_info(Some(" ".into()), None), None);
        let broken = click_from_user_info(Some("key-2".into()), Some("{not json".into())).unwrap();
        assert_eq!(broken.item, serde_json::Value::Null);
    }

    #[test]
    fn a_banner_defaults_its_tag_to_its_id_and_its_sound_to_the_system_one() {
        let banner = plan_banner(" notif-1 ", " Approve? ", Some(" body "), None, None).unwrap();
        assert_eq!(banner.id, "notif-1");
        assert_eq!(banner.identifier, "snaglet-banner:notif-1");
        assert_eq!(banner.title, "Approve?");
        assert_eq!(banner.body, "body");
        assert_eq!(banner.sound, NotificationSound::SystemDefault);
    }

    #[test]
    fn banners_of_one_tag_share_an_identifier_and_never_a_reminders() {
        let a = plan_banner("n-1", "A", None, None, Some("run_failed")).unwrap();
        let b = plan_banner("n-2", "B", None, None, Some("run_failed")).unwrap();
        assert_eq!(a.identifier, b.identifier);
        assert_ne!(a.id, b.id);
        assert!(a.identifier.starts_with("snaglet-banner:"));
        assert_eq!(banner_identifier("n-1"), "snaglet-banner:n-1");
        // A blank tag falls back to the id.
        assert_eq!(
            plan_banner("n-3", "C", None, None, Some("  "))
                .unwrap()
                .identifier,
            "snaglet-banner:n-3"
        );
    }

    #[test]
    fn a_banner_picks_silent_bundled_or_system_sound() {
        let sound = |id: Option<&str>| plan_banner("n", "T", None, id, None).unwrap().sound;
        assert_eq!(sound(Some("none")), NotificationSound::Silent);
        assert_eq!(
            sound(Some("marimba")),
            NotificationSound::Bundled("marimba.wav".into())
        );
        assert_eq!(sound(Some("default")), NotificationSound::SystemDefault);
        assert_eq!(sound(Some("nonsense")), NotificationSound::SystemDefault);
    }

    #[test]
    fn a_banner_needs_an_id_and_falls_back_to_a_title() {
        assert_eq!(plan_banner("  ", "T", None, None, None), None);
        assert_eq!(
            plan_banner("n", "  ", None, None, None).unwrap().title,
            "Snaglet"
        );
        assert_eq!(plan_banner("n", "T", None, None, None).unwrap().body, "");
    }

    #[test]
    fn a_banner_click_names_its_banner_and_ignores_reminders() {
        assert_eq!(
            banner_click_from_user_info(Some("notif-1".into())),
            Some(BannerClick {
                id: "notif-1".into()
            })
        );
        assert_eq!(banner_click_from_user_info(None), None);
        assert_eq!(banner_click_from_user_info(Some(" ".into())), None);
        assert_eq!(
            serde_json::to_value(BannerClick { id: "n".into() }).unwrap(),
            json!({ "id": "n" })
        );
    }

    #[test]
    fn pending_click_is_taken_once() {
        stash_click(ReminderClick {
            key: "key-1".into(),
            item: json!(null),
        });
        assert_eq!(
            notifications_take_clicked().map(|click| click.key),
            Some("key-1".into())
        );
        assert_eq!(notifications_take_clicked(), None);
    }

    #[test]
    fn every_bundled_sound_is_packaged_where_sound_named_finds_it() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let files = config["bundle"]["macOS"]["files"].as_object().unwrap();
        assert_eq!(files.len(), BUNDLED_SOUNDS.len());
        let tauri_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for id in BUNDLED_SOUNDS {
            let source = files[&format!("Resources/{id}.wav")].as_str().unwrap();
            assert_eq!(
                source,
                format!("../../desktop-ui/public/sounds/reminders/{id}.wav")
            );
            assert!(
                tauri_dir.join(source).is_file(),
                "missing reminder sound {source}"
            );
        }
    }

    #[test]
    fn reminder_capability_lets_only_the_loopback_page_listen() {
        use tauri::utils::acl::RemoteUrlPattern;
        let capability: serde_json::Value = serde_json::from_str(include_str!(
            "../../capabilities/reminder-notifications.json"
        ))
        .unwrap();
        assert_eq!(capability["windows"], json!(["main"]));
        assert_eq!(
            capability["permissions"],
            json!(["core:event:allow-listen", "core:event:allow-unlisten"])
        );
        let urls = capability["remote"]["urls"].as_array().unwrap();
        assert_eq!(urls.len(), 1);
        let pattern: RemoteUrlPattern = urls[0].as_str().unwrap().parse().unwrap();
        let matches = |url: &str| pattern.test(&url.parse().unwrap());
        assert!(matches("http://127.0.0.1:49152/"));
        assert!(matches(
            "http://127.0.0.1:4011/workspace?pane=calendar#today"
        ));
        assert!(!matches("http://localhost:49152/"));
        assert!(!matches("https://127.0.0.1:49152/"));
        assert!(!matches("http://example.com/"));
    }
}
