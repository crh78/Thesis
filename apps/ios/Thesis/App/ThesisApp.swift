import SwiftUI
import UserNotifications

@main
struct ThesisApp: App {
    @AppStorage("appearance") private var appearance: Appearance = .dark
    @State private var app = AppState()
    @State private var session = SessionStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            AppGate()
                .environment(app)
                .environment(session)
                .task { await session.start() }
                // Take links from chat; held until signed in (RootView opens it).
                .onOpenURL { open($0) }
                .onAppear {
                    UNUserNotificationCenter.current().delegate = NotificationTaps.shared
                    NotificationTaps.shared.onOpen = { open($0) }
                }
                .preferredColorScheme(appearance.colorScheme)
                .tint(Palette.text)
        }
        // Leaving the app: ask for a background check of the inbox. Coming back: check now.
        .onChange(of: phase) { _, now in
            if now == .background { LocalNotifier.scheduleRefresh() }
            if now == .active { Task { await app.refreshNotifications() } }
        }
        .backgroundTask(.appRefresh(LocalNotifier.refreshTaskID)) {
            await app.refreshNotifications()
            LocalNotifier.scheduleRefresh()
        }
    }
}

extension ThesisApp {
    /// Take links (chat, the web, the share sheet, a tapped X-call notification).
    func open(_ url: URL) {
        if let take = TakeLink(url: url) { app.openedTake = take }
        else if let receipt = TakeReceiptLink(url: url) { app.openedReceipt = receipt }
    }
}

/// Dark is the default; Settings on the profile lets people switch.
enum Appearance: String, CaseIterable, Identifiable {
    case dark, light, system

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .dark: .dark
        case .light: .light
        case .system: nil
        }
    }
}
