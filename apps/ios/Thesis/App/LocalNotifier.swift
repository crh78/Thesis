import BackgroundTasks
import Foundation
import UserNotifications

/// Shows inbox notifications as iOS notifications without APNs. The team is a personal one, so
/// the Push Notifications capability can't be provisioned yet. Instead the app checks its inbox
/// when it becomes active and through Background App Refresh, and raises each new unread
/// notification locally. With a paid team, a server sender (APNs) can replace the background check;
/// the inbox stays the source of truth.
enum LocalNotifier {
    static let refreshTaskID = "xyz.yourthesis.app.inbox-refresh"
    /// The newest notification id already raised (or seen at first load), per install.
    private static let lastRaisedKey = "notifications.lastRaisedID"

    static func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }

    /// Raises the unread notifications newer than the last one raised. The first call on an
    /// install raises nothing and just remembers the newest, so old ones aren't replayed.
    static func raise(_ unread: [AppNotification]) async {
        let defaults = UserDefaults.standard
        let newest = unread.map(\.id).max() ?? 0
        guard defaults.object(forKey: lastRaisedKey) != nil else {
            defaults.set(newest, forKey: lastRaisedKey)
            return
        }
        let last = defaults.integer(forKey: lastRaisedKey)
        let fresh = unread.filter { $0.id > last }.sorted { $0.id < $1.id }
        guard !fresh.isEmpty else { return }
        defaults.set(max(last, newest), forKey: lastRaisedKey)

        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }
        for n in fresh.suffix(5) {
            let content = UNMutableNotificationContent()
            content.title = n.title
            content.body = n.body
            content.sound = .default
            content.threadIdentifier = n.kind
            if let take = n.takeId { content.userInfo = ["take_id": take] }
            if let link = n.copyLink?.url { content.userInfo = ["open": link.absoluteString] }
            try? await center.add(UNNotificationRequest(identifier: "inbox-\(n.id)", content: content, trigger: nil))
        }
        try? await center.setBadgeCount(unread.count)
    }

    /// Asks iOS to wake the app to check the inbox (it decides when; roughly every 15+ minutes).
    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// Taps on raised notifications. An X call opens its take, basket built (`open` in userInfo).
final class NotificationTaps: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationTaps()

    /// Set once the app is up; a tap that launched the app waits in `pending` until then.
    @MainActor var onOpen: ((URL) -> Void)? {
        didSet {
            if let onOpen, let url = pending {
                pending = nil
                onOpen(url)
            }
        }
    }
    @MainActor private var pending: URL?

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let raw = response.notification.request.content.userInfo["open"] as? String,
              let url = URL(string: raw) else { return }
        await MainActor.run {
            if let onOpen { onOpen(url) } else { pending = url }
        }
    }
}
