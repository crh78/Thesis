import AuthenticationServices
import Foundation
import Observation
import os
import PrivySDK

enum OnboardingStep: Equatable {
    case profile, photo, location
    /// Optional last step (client-side only): the server already counts you
    /// as onboarded once location is saved.
    case follows
}

/// What the profile-photo picker saves.
enum AvatarSelection: Equatable {
    case face(String, color: Int)
    case photo(jpeg: Data)
    /// Keep the current photo (edit mode only).
    case unchanged
}

enum SessionPhase: Equatable {
    /// Reading the saved session at launch.
    case launching
    case signedOut
    /// Just signed in: creating the wallet and loading the profile.
    case settingUp
    case onboarding(OnboardingStep)
    case ready
    /// Signed in, but the profile couldn't be loaded (and nothing is cached).
    case failed(String)
}

enum SocialProvider {
    case apple, google
}

/// Owns the Privy client and the signed-in user.
///
/// Staying signed in: Privy keeps the session in the keychain, so on launch we
/// just ask it for the saved auth state. If the phone is offline Privy reports
/// `authenticatedUnverified`; we keep the user in on their cached profile and
/// refresh once it comes back online.
@MainActor @Observable
final class SessionStore {
    private(set) var phase: SessionPhase = .launching
    private(set) var snapshot: SessionSnapshot?
    /// Prefill for the name field (from Google, or the email address).
    private(set) var nameHint = ""
    /// Set by any Log out button; AppGate shows the one confirmation dialog.
    var logOutRequested = false
    /// Set when onboarding ends (after the follow step); the app offers Add cash once, then clears it.
    var finishedOnboarding = false

    @ObservationIgnored private let privy: any Privy
    @ObservationIgnored private let api: SessionAPI
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var restoredFromCache = false
    @ObservationIgnored private let log = Logger(subsystem: "xyz.yourthesis.app", category: "session")

    init(api: SessionAPI = SessionAPI()) {
        self.api = api
        // Privy's own logs go to the unified log under category "privy".
        let privyLog = Logger(subsystem: "xyz.yourthesis.app", category: "privy")
        #if DEBUG
        let level = PrivyLogLevel.debug
        #else
        let level = PrivyLogLevel.error
        #endif
        let logging = PrivyLoggingConfig(logLevel: level) { _, message in
            privyLog.log("\(message, privacy: .public)")
        }
        privy = PrivySdk.initialize(config: PrivyConfig(
            appId: AppConfig.privyAppID,
            appClientId: AppConfig.privyClientID,
            loggingConfig: logging
        ))
    }

    // MARK: Launch

    func start() async {
        guard watcher == nil else { return }
        #if DEBUG
        if LaunchFlags.skipsAuth { phase = .ready; return }
        if LaunchFlags.onboardingScreen != nil { return }
        #endif
        watcher = Task { [weak self] in await self?.watchAuthState() }
        await restore()
    }

    func retry() async {
        phase = .launching
        await restore()
    }

    private func restore() async {
        switch await privy.getAuthState() {
        case .authenticated(let user):
            // Someone already set up goes straight in on their last known profile, refreshed in
            // the background; "Setting up your account" is only for a first sign-in.
            if let cached = SessionCache.load(), !cached.needsOnboarding {
                apply(cached)
                await finishSignIn(user, quietly: true)
            } else {
                await finishSignIn(user)
            }
        case .authenticatedUnverified:
            if let cached = SessionCache.load() {
                restoredFromCache = true
                apply(cached)
            } else {
                phase = .failed("You're offline. Connect to the internet to finish signing in.")
            }
        case .unauthenticated, .notReady:
            phase = .signedOut
        @unknown default:
            phase = .signedOut
        }
    }

    /// Reacts to changes Privy makes on its own: a session expiring, or coming
    /// back online after launching on a cached profile. Sign-ins started from
    /// the UI are handled where they're called, not here.
    private func watchAuthState() async {
        for await state in privy.authStateStream {
            switch state {
            case .unauthenticated:
                if phase != .signedOut && phase != .launching {
                    log.info("session ended")
                    signOutLocally()
                }
            case .authenticated(let user):
                if case .failed = phase {
                    await finishSignIn(user)
                } else if restoredFromCache {
                    restoredFromCache = false
                    await finishSignIn(user, quietly: true)
                }
            default:
                break
            }
        }
    }

    // MARK: Sign in

    func sendEmailCode(to email: String) async throws {
        try await logged("send email code") { try await privy.email.sendCode(to: email) }
    }

    func verifyEmailCode(_ code: String, email: String) async throws {
        let user = try await logged("email login") { try await privy.email.loginWithCode(code, sentTo: email) }
        await finishSignIn(user)
    }

    func signIn(with provider: SocialProvider) async throws {
        let user = try await logged("oauth login") {
            try await privy.oAuth.login(with: provider == .apple ? .apple : .google, appUrlScheme: AppConfig.urlScheme)
        }
        await finishSignIn(user)
    }

    #if DEBUG
    var devLoginAvailable: Bool { AppConfig.devLogin != nil }

    /// Debug builds only: username/password → the Privy test account (fixed email + code).
    func devLogin(username: String, password: String) async throws {
        guard let dev = AppConfig.devLogin else { throw DevLoginError.notConfigured }
        guard username.trimmingCharacters(in: .whitespaces).lowercased() == dev.username.lowercased(),
              password == dev.password else { throw DevLoginError.wrongCredentials }
        try await sendEmailCode(to: dev.email)
        let user = try await logged("dev login") { try await privy.email.loginWithCode(dev.code, sentTo: dev.email) }
        // Every dev login starts from scratch, so it always goes through onboarding.
        await finishSignIn(user, resetTestAccount: true, nameHint: dev.username.capitalized)
    }
    #endif

    /// Sign-in errors are shown to the user as friendly text; keep the real one in the log.
    private func logged<T>(_ what: String, _ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch {
            log.error("\(what, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    private func finishSignIn(_ user: any PrivyUser, quietly: Bool = false,
                              resetTestAccount: Bool = false, nameHint hint: String? = nil) async {
        if !quietly { phase = .settingUp }
        nameHint = hint ?? Self.nameHint(from: user)

        // Every user gets a wallet without ever seeing one. A failure here isn't
        // fatal: the server picks the address up on a later launch.
        if user.embeddedSolanaWallets.isEmpty {
            do {
                _ = try await user.createSolanaWallet()
            } catch {
                log.error("wallet creation failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        do {
            let token = try await user.getAccessToken()
            apply(try await resetTestAccount ? api.resetTestAccount(token: token) : api.fetch(token: token))
        } catch {
            log.error("loading profile failed: \(error.localizedDescription, privacy: .public)")
            guard !quietly else { return }
            phase = .failed(AuthErrorText.message(for: error) ?? "Couldn't load your account.")
        }
    }

    // MARK: Onboarding

    func saveProfile(name: String, handle: String) async throws {
        try await update(SessionUpdate(handle: handle, displayName: name))
    }

    /// Onboarding's profile step with an optional bio. Name and handle go to the
    /// session; the bio to the social layer, which needs the handle to exist first.
    /// The step only advances once both are saved, so a failed bio can be retried.
    func saveProfile(name: String, handle: String, bio: String) async throws {
        let bio = bio.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !bio.isEmpty else { return try await saveProfile(name: name, handle: handle) }
        guard let user = await privy.getUser() else {
            signOutLocally()
            throw SessionAPIError.unauthorized
        }
        let token = try await user.getAccessToken()
        let saved = try await api.update(SessionUpdate(handle: handle, displayName: name), token: token)
        _ = try await SocialAPI(token: { token }).updateBio(bio)
        apply(saved)
    }

    func saveLocation(country: String, usState: String?) async throws {
        try await update(SessionUpdate(country: country, usState: usState))
        // Location finishes onboarding on the server; offer follows before the app.
        if snapshot?.needsOnboarding == false { phase = .onboarding(.follows) }
    }

    /// Done with (or skipped) the follow step.
    func finishOnboarding() {
        guard phase == .onboarding(.follows) else { return }
        finishedOnboarding = true // the app offers Add cash once
        phase = .ready
    }

    /// The fork API as the signed-in user, when this build is in fork mode and the user has a
    /// Privy Solana wallet. The wallet signs each transaction; it never sends anything itself.
    func forkAPI() async -> ForkAPI? {
        guard let base = AppConfig.forkAPIURL,
              let user = await privy.getUser(),
              let wallet = user.embeddedSolanaWallets.first else { return nil }
        var signer = ForkWallet(address: wallet.address) { transaction in
            let signed = try await wallet.provider.signTransaction(transaction: transaction)
            guard let data = Data(base64Encoded: signed) else { throw ForkAPIError(code: "bad_signature", message: nil) }
            return data
        }
        // Privy takes the message base64-encoded and returns the signature base64-encoded.
        signer.signMessage = { text in
            let signed = try await wallet.provider.signMessage(message: Data(text.utf8).base64EncodedString())
            guard let data = Data(base64Encoded: signed) else { throw ForkAPIError(code: "bad_signature", message: nil) }
            return data
        }
        // Through accessToken(), which signs you out here if Privy no longer has you, so the app
        // shows sign-in instead of failing every trade.
        return ForkAPI(base: base, wallet: signer, accessToken: { [weak self] in
            guard let self else { throw SessionAPIError.unauthorized }
            return try await self.accessToken()
        })
    }

    /// Social reads/writes as the signed-in user (used before AppState connects).
    func socialAPI() -> SocialAPI {
        SocialAPI(token: { [weak self] in
            guard let self else { throw SessionAPIError.unauthorized }
            return try await self.accessToken()
        })
    }

    func saveAvatar(_ selection: AvatarSelection) async throws {
        #if DEBUG
        if LaunchFlags.skipsAuth { return } // mock-data mode: nothing to save to
        #endif
        switch selection {
        case .face(let name, let color):
            try await update(SessionUpdate(avatar: AvatarFace.encode(name, color: color)))
        case .photo(let jpeg):
            guard let user = await privy.getUser() else {
                signOutLocally()
                throw SessionAPIError.unauthorized
            }
            let token = try await user.getAccessToken()
            apply(try await api.uploadAvatar(jpeg: jpeg, token: token))
        case .unchanged:
            break
        }
    }

    /// `nil` when it couldn't be checked; the save will catch a taken handle anyway.
    func isHandleAvailable(_ handle: String) async -> Bool? {
        try? await api.isHandleAvailable(handle)
    }

    /// A current Privy access token for backend calls (the social API uses it).
    /// Signs out locally if Privy no longer has a user.
    func accessToken() async throws -> String {
        guard let user = await privy.getUser() else {
            signOutLocally()
            throw SessionAPIError.unauthorized
        }
        return try await user.getAccessToken()
    }

    private func update(_ fields: SessionUpdate) async throws {
        guard let user = await privy.getUser() else {
            signOutLocally()
            throw SessionAPIError.unauthorized
        }
        let token = try await user.getAccessToken()
        apply(try await api.update(fields, token: token))
    }

    // MARK: Sign out

    /// Deletes the account on the server, then signs out here.
    func deleteAccount() async throws {
        let token = try await accessToken()
        try await api.deleteAccount(token: token)
        // The Privy user is gone server-side (except test accounts); logging out
        // can fail for a deleted user, so always clear the local session.
        if let user = await privy.getUser() { await user.logout() }
        signOutLocally()
    }

    func logOut() async {
        #if DEBUG
        // Mock-data mode (UI tests, screenshots) never signed in: don't touch the real session.
        if LaunchFlags.skipsAuth { signOutLocally(); return }
        #endif
        if let user = await privy.getUser() {
            await user.logout()
        }
        signOutLocally()
    }

    private func signOutLocally() {
        snapshot = nil
        nameHint = ""
        restoredFromCache = false
        SessionCache.clear()
        phase = .signedOut
    }

    // MARK: Helpers

    private func apply(_ snapshot: SessionSnapshot) {
        self.snapshot = snapshot
        SessionCache.save(snapshot)
        if !snapshot.needsOnboarding {
            phase = .ready
        } else if snapshot.profile.handle == nil {
            phase = .onboarding(.profile)
        } else if !snapshot.profile.hasAvatar {
            phase = .onboarding(.photo)
        } else {
            phase = .onboarding(.location)
        }
    }

    private static func nameHint(from user: any PrivyUser) -> String {
        for account in user.linkedAccounts {
            if case .google(let google) = account, let name = google.name, !name.isEmpty {
                return name
            }
        }
        for account in user.linkedAccounts {
            switch account {
            case .email(let email): return localPart(email.email)
            case .apple(let apple): return localPart(apple.email)
            default: continue
            }
        }
        return ""
    }

    /// "sarah.k@gmail.com" → "Sarah K". Apple's private relay addresses are noise, so skip them.
    private static func localPart(_ email: String) -> String {
        guard !email.hasSuffix("privaterelay.appleid.com"),
              let local = email.split(separator: "@").first else { return "" }
        return local
            .split(whereSeparator: { ".-_+".contains($0) })
            .filter { !$0.allSatisfy(\.isNumber) }
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

/// Last known profile, so a signed-in user opening the app offline still gets in.
/// Not sensitive (handle, name, country); the session itself is in Privy's keychain.
enum SessionCache {
    private static let key = "session.snapshot.v1"

    static func load() -> SessionSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(SessionSnapshot.self, from: data)
    }

    static func save(_ snapshot: SessionSnapshot) {
        UserDefaults.standard.set(try? JSONEncoder().encode(snapshot), forKey: key)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// User-facing text for sign-in errors. `nil` means the user cancelled: say nothing.
enum AuthErrorText {
    static func message(for error: Error) -> String? {
        if isCancellation(error) { return nil }
        #if DEBUG
        if let dev = error as? DevLoginError { return dev.errorDescription }
        #endif
        if let api = error as? SessionAPIError { return api.errorDescription }
        if let privy = error as? PrivyError, case .authenticationFailure(let reason) = privy.errorCode {
            switch reason {
            case .incorrectCredentials: return "That code isn't right. Check it and try again."
            case .sessionExpired, .notLoggedIn: return "Your session ended. Sign in again."
            case .failureDuringAuthentication(let inner): return message(for: inner)
            default: break
            }
        }
        if error is URLError { return SessionAPIError.offline.errorDescription }
        return "Something went wrong. Try again."
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if let privy = error as? PrivyError,
           case .authenticationFailure(.failureDuringAuthentication(let inner)) = privy.errorCode {
            return isCancellation(inner)
        }
        if error is CancellationError { return true }
        let ns = error as NSError
        if ns.domain == ASAuthorizationError.errorDomain, ns.code == ASAuthorizationError.canceled.rawValue { return true }
        if ns.domain == ASWebAuthenticationSessionError.errorDomain,
           ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue { return true }
        return false
    }
}

#if DEBUG
enum DevLoginError: LocalizedError {
    case notConfigured, wrongCredentials

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Dev login isn't set up. Fill in apps/ios/Config/DevLogin.local.xcconfig."
        case .wrongCredentials: "Wrong username or password."
        }
    }
}

/// Debug launch arguments.
/// - `-skipAuth`: go straight to the app (UI tests, screenshots).
/// - `-screen <welcome|email|handle|avatar|location|follows>`: open an onboarding screen with stubbed actions.
/// Any existing `-screen` route (feed, take, …) also skips auth.
enum LaunchFlags {
    static var skipsAuth: Bool {
        ProcessInfo.processInfo.arguments.contains("-skipAuth") || DebugRoute.current != nil
    }

    static var onboardingScreen: OnboardingDebugScreen? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-screen"), i + 1 < args.count else { return nil }
        return OnboardingDebugScreen(rawValue: args[i + 1])
    }
}

enum OnboardingDebugScreen: String {
    case welcome, email, handle, avatar, location, follows
}
#endif
