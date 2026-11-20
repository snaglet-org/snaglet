//! macOS backend: Apple's UserNotifications framework, called from the app
//! process itself — macOS only lets a process with Snaglet's bundle identity post
//! notifications as Snaglet, so this cannot live in the Node sidecar.
//!
//! Requests are handed to `UNUserNotificationCenter` ahead of time with a
//! calendar trigger, so the system delivers them on time even while Snaglet is
//! quit, as a banner with the reminder's bundled sound.

use std::ptr::NonNull;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{
    NSArray, NSBundle, NSCalendar, NSCalendarUnit, NSDate, NSDictionary, NSError, NSObject,
    NSObjectProtocol, NSString,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNCalendarNotificationTrigger,
    UNMutableNotificationContent, UNNotification, UNNotificationContent,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNNotificationTrigger,
    UNTimeIntervalNotificationTrigger, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::{
    banner_click_from_user_info, click_from_user_info, deliver_banner_click, deliver_click,
    NativeNotificationStatus, NotificationPermission, NotificationSound, PlannedBanner,
    PlannedNotification, USER_INFO_BANNER_ID, USER_INFO_ITEM, USER_INFO_KEY,
};

/// Groups Snaglet's reminders together in Notification Center.
const THREAD_IDENTIFIER: &str = "snaglet-reminders";
/// Groups Snaglet's run alerts, mentions and approvals together in Notification Center.
const BANNER_THREAD_IDENTIFIER: &str = "snaglet-alerts";
/// Closer than this, a whole-second calendar match could already be past by
/// the time the system registers it, so a relative trigger is used instead.
const RELATIVE_TRIGGER_BELOW_SECS: f64 = 5.0;
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(3);
/// The permission prompt waits on the user; the UI can re-check later.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const SCHEDULE_TIMEOUT: Duration = Duration::from_secs(10);

/// `UNUserNotificationCenter.currentNotificationCenter` raises an
/// Objective-C exception (which would abort Snaglet) when the process is not a
/// registered `.app` with a bundle identifier — e.g. the bare
/// `target/debug/desktop` that `tauri dev` runs. Gate on the bundle first and
/// catch the exception as a second line of defense; either way Snaglet reports
/// `supported: false` instead of crashing.
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    let available = *AVAILABLE.get_or_init(|| {
        let bundle = NSBundle::mainBundle();
        let has_identifier = bundle
            .bundleIdentifier()
            .is_some_and(|identifier| !identifier.to_string().is_empty());
        has_identifier
            && bundle.bundlePath().to_string().ends_with(".app")
            && objc2::exception::catch(UNUserNotificationCenter::currentNotificationCenter).is_ok()
    });
    if !available {
        return None;
    }
    objc2::exception::catch(UNUserNotificationCenter::currentNotificationCenter).ok()
}

fn permission_from(status: UNAuthorizationStatus) -> NotificationPermission {
    if status == UNAuthorizationStatus::NotDetermined {
        NotificationPermission::Unknown
    } else if status == UNAuthorizationStatus::Denied {
        NotificationPermission::Denied
    } else {
        // Authorized, Provisional (quiet delivery) and Ephemeral all deliver.
        NotificationPermission::Granted
    }
}

fn read_permission(center: &UNUserNotificationCenter) -> NotificationPermission {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the framework passes a valid settings object for the call.
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = sender.send(status);
    });
    center.getNotificationSettingsWithCompletionHandler(&handler);
    receiver
        .recv_timeout(SETTINGS_TIMEOUT)
        .map_or(NotificationPermission::Unknown, permission_from)
}

fn log_error(context: &str, error: *mut NSError) {
    // SAFETY: the framework passes either nil or a valid NSError.
    if let Some(error) = unsafe { error.as_ref() } {
        eprintln!(
            "[notifications] {context}: {}",
            error.localizedDescription()
        );
    }
}

pub(super) fn install() {
    let Some(center) = center() else {
        return;
    };
    let delegate = NotificationDelegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives as long as Snaglet.
    std::mem::forget(delegate);
}

pub(super) fn status() -> NativeNotificationStatus {
    match center() {
        Some(center) => NativeNotificationStatus::supported(read_permission(&center)),
        None => NativeNotificationStatus::unsupported(),
    }
}

pub(super) fn request_permission() -> NativeNotificationStatus {
    let Some(center) = center() else {
        return NativeNotificationStatus::unsupported();
    };
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
        log_error("permission request failed", error);
        let _ = sender.send(());
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
    let _ = receiver.recv_timeout(PROMPT_TIMEOUT);
    NativeNotificationStatus::supported(read_permission(&center))
}

/// Drop every pending Snaglet request and add `planned`. Returns
/// `(accepted, refused or unconfirmed)`, or `None` when unsupported.
pub(super) fn replace_pending(
    planned: &[PlannedNotification],
    now_ms: i64,
) -> Option<(usize, usize)> {
    let center = center()?;
    // Every pending request in Snaglet's center is one Snaglet scheduled, so clearing
    // them all removes exactly Snaglet's own.
    center.removeAllPendingNotificationRequests();
    let (sender, receiver) = mpsc::channel::<bool>();
    for notification in planned {
        let request = build_request(notification, now_ms);
        let sender = sender.clone();
        let handler = RcBlock::new(move |error: *mut NSError| {
            log_error("could not schedule a reminder", error);
            let _ = sender.send(error.is_null());
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    }
    drop(sender);
    let deadline = Instant::now() + SCHEDULE_TIMEOUT;
    let mut accepted = 0;
    let mut answered = 0;
    while answered < planned.len() {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(ok) => {
                answered += 1;
                accepted += usize::from(ok);
            }
            Err(_) => break,
        }
    }
    Some((accepted, planned.len() - accepted))
}

pub(super) fn cancel_all() {
    if let Some(center) = center() {
        center.removeAllPendingNotificationRequests();
    }
}

/// Deliver `banner` now. `Some(true)` when the OS accepted it, `Some(false)`
/// when it refused (e.g. notifications are off for Snaglet) or did not confirm in
/// time, `None` when this process cannot post notifications.
pub(super) fn show_now(banner: &PlannedBanner) -> Option<bool> {
    let center = center()?;
    let (sender, receiver) = mpsc::channel::<bool>();
    let request = build_banner_request(banner);
    let handler = RcBlock::new(move |error: *mut NSError| {
        log_error("could not show a banner", error);
        let _ = sender.send(error.is_null());
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    Some(receiver.recv_timeout(SCHEDULE_TIMEOUT).unwrap_or(false))
}

/// Remove the delivered banner with this OS identifier from Notification Center.
pub(super) fn close_delivered(identifier: &str) {
    if let Some(center) = center() {
        let identifiers = NSArray::from_retained_slice(&[NSString::from_str(identifier)]);
        center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
    }
}

fn set_sound(content: &UNMutableNotificationContent, sound: &NotificationSound) {
    match sound {
        NotificationSound::Silent => {}
        NotificationSound::Bundled(file) => {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
                file,
            ))));
        }
        NotificationSound::SystemDefault => {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
    }
}

/// A request with no trigger, which the system delivers immediately.
fn build_banner_request(banner: &PlannedBanner) -> Retained<UNNotificationRequest> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&banner.title));
    content.setBody(&NSString::from_str(&banner.body));
    content.setThreadIdentifier(&NSString::from_str(BANNER_THREAD_IDENTIFIER));
    set_sound(&content, &banner.sound);
    let key = NSString::from_str(USER_INFO_BANNER_ID);
    let value = NSString::from_str(&banner.id);
    let user_info: Retained<NSDictionary<NSString, NSString>> =
        NSDictionary::from_slices(&[&*key], &[&*value]);
    // SAFETY: string key and value form a valid property list; the cast only
    // widens the generic parameters.
    unsafe { content.setUserInfo(user_info.cast_unchecked::<AnyObject, AnyObject>()) };
    let content: &UNNotificationContent = &content;
    UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&banner.identifier),
        content,
        None,
    )
}

fn build_request(
    notification: &PlannedNotification,
    now_ms: i64,
) -> Retained<UNNotificationRequest> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    content.setThreadIdentifier(&NSString::from_str(THREAD_IDENTIFIER));
    set_sound(&content, &notification.sound);
    let info_keys = [
        NSString::from_str(USER_INFO_KEY),
        NSString::from_str(USER_INFO_ITEM),
    ];
    let info_values = [
        NSString::from_str(&notification.key),
        NSString::from_str(&notification.item_json),
    ];
    let user_info: Retained<NSDictionary<NSString, NSString>> = NSDictionary::from_slices(
        &[&*info_keys[0], &*info_keys[1]],
        &[&*info_values[0], &*info_values[1]],
    );
    // SAFETY: string keys and values form a valid property list, which is
    // all userInfo requires; the cast only widens the generic parameters.
    unsafe { content.setUserInfo(user_info.cast_unchecked::<AnyObject, AnyObject>()) };
    let content: &UNNotificationContent = &content;

    let seconds_ahead = (notification.fire_at_ms - now_ms) as f64 / 1000.0;
    let trigger: Retained<UNNotificationTrigger> = if seconds_ahead < RELATIVE_TRIGGER_BELOW_SECS {
        Retained::into_super(
            UNTimeIntervalNotificationTrigger::triggerWithTimeInterval_repeats(
                seconds_ahead.max(1.0),
                false,
            ),
        )
    } else {
        // A wall-clock match in the user's calendar: unlike a relative
        // interval it stays right across sleep and clock corrections.
        let fire_at =
            NSDate::dateWithTimeIntervalSince1970(notification.fire_at_ms as f64 / 1000.0);
        let units = NSCalendarUnit::Year
            | NSCalendarUnit::Month
            | NSCalendarUnit::Day
            | NSCalendarUnit::Hour
            | NSCalendarUnit::Minute
            | NSCalendarUnit::Second;
        let components = NSCalendar::currentCalendar().components_fromDate(units, &fire_at);
        Retained::into_super(
            UNCalendarNotificationTrigger::triggerWithDateMatchingComponents_repeats(
                &components,
                false,
            ),
        )
    };
    UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&notification.key),
        content,
        Some(&trigger),
    )
}

fn read_user_info_string(info: &NSDictionary<NSString, AnyObject>, key: &str) -> Option<String> {
    info.objectForKey(&NSString::from_str(key))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|value| value.to_string())
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class does
    // not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "SnagletReminderNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// Snaglet is frontmost: still show the banner and play the sound.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::List,));
        }

        /// The user clicked a delivered reminder.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let user_info = response.notification().request().content().userInfo();
            // SAFETY: only used for lookups by NSString key; values are
            // type-checked with `downcast` before use.
            let user_info: &NSDictionary<NSString, AnyObject> =
                unsafe { user_info.cast_unchecked() };
            if let Some(click) =
                banner_click_from_user_info(read_user_info_string(user_info, USER_INFO_BANNER_ID))
            {
                deliver_banner_click(click);
            } else if let Some(click) = click_from_user_info(
                read_user_info_string(user_info, USER_INFO_KEY),
                read_user_info_string(user_info, USER_INFO_ITEM),
            ) {
                deliver_click(click);
            }
            completion_handler.call(());
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test binary is not an `.app`: every entry point must answer
    /// "unsupported" rather than touch the center (which would raise).
    #[test]
    fn a_bare_binary_reports_unsupported_instead_of_crashing() {
        assert_eq!(status(), NativeNotificationStatus::unsupported());
        assert_eq!(
            request_permission(),
            NativeNotificationStatus::unsupported()
        );
        assert_eq!(replace_pending(&[], 0), None);
        let banner = super::super::plan_banner("n", "T", None, None, None).unwrap();
        assert_eq!(show_now(&banner), None);
        close_delivered(&banner.identifier);
        cancel_all();
        install();
    }

    #[test]
    fn authorization_statuses_map_to_the_contract() {
        assert_eq!(
            permission_from(UNAuthorizationStatus::NotDetermined),
            NotificationPermission::Unknown
        );
        assert_eq!(
            permission_from(UNAuthorizationStatus::Denied),
            NotificationPermission::Denied
        );
        assert_eq!(
            permission_from(UNAuthorizationStatus::Authorized),
            NotificationPermission::Granted
        );
        assert_eq!(
            permission_from(UNAuthorizationStatus::Provisional),
            NotificationPermission::Granted
        );
        assert_eq!(
            permission_from(UNAuthorizationStatus::Ephemeral),
            NotificationPermission::Granted
        );
    }
}
