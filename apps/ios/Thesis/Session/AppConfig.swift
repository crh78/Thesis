import Foundation

/// Backend config for this build (Debug = dev, Release = prod).
/// Build settings → Info.plist: `project.yml`, plus the gitignored Config/Backend.local.xcconfig and
/// Config/Privy.local.xcconfig for the backend values. Nothing secret lives here.
enum AppConfig {
    static let privyAppID = value("PrivyAppID")
    static let privyClientID = value("PrivyClientID")
    static let supabaseURL = URL(string: value("SupabaseURL"))!
    static let supabasePublishableKey = value("SupabasePublishableKey")
    /// Google / Apple sign-in return here. Also listed in Privy's allowed URL schemes.
    static let urlScheme = value("AppURLScheme")
    /// The web app (apps/www). Share links point at its take pages, where anyone can trade.
    static let webURL = URL(string: value("WebURL"))!
    static func takeURL(_ id: String) -> URL { webURL.appending(path: "t/\(id)") }
    /// A person's public page (`/u/<handle>`): their takes and the ones they called.
    static func profileURL(_ handle: String) -> URL { webURL.appending(path: "u/\(handle)") }

    /// Off until the team is in the paid Apple Developer Program (see project.yml).
    static let appleSignInEnabled = value("AppleSignInEnabled") == "YES"

    /// The fork API (`https://<fork-host>`): cash, trades, posting and receipts all go through it.
    /// Required: set by the gitignored Config/Fork.local.xcconfig (Debug and Release). Nil when it's
    /// missing, and then the app stops at launch on a screen that says so (AppGate) instead of
    /// running without money. UI tests and `-screen` previews run on mock data and don't need it.
    static let forkAPIURL: URL? = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "ForkAPIURL") as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
        return URL(string: trimmed)
    }()

    #if DEBUG
    /// Debug-only username/password that signs in to the Privy test account.
    /// `nil` unless Config/DevLogin.local.xcconfig is filled in.
    struct DevLogin {
        let username, password, email, code: String
    }

    static let devLogin: DevLogin? = {
        let values = ["DevLoginUsername", "DevLoginPassword", "DevLoginEmail", "DevLoginCode"].map {
            (Bundle.main.object(forInfoDictionaryKey: $0) as? String ?? "").trimmingCharacters(in: .whitespaces)
        }
        guard values.allSatisfy({ !$0.isEmpty && !$0.hasPrefix("$(") }) else { return nil }
        return DevLogin(username: values[0], password: values[1], email: values[2], code: values[3])
    }()
    #endif

    private static func value(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty, !value.hasPrefix("$(") else {
            fatalError("Missing \(key) in Info.plist. Backend values go in apps/ios/Config/Backend.local.xcconfig and Privy.local.xcconfig (copy the .example files); the rest in apps/ios/project.yml. Then re-run `xcodegen generate`.")
        }
        return value
    }
}
