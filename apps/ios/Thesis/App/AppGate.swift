import SwiftUI

/// Decides what the app shows: sign-in, onboarding, or the app itself.
/// Signed-in users skip straight to the app on every launch.
struct AppGate: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        #if DEBUG
        if let screen = LaunchFlags.onboardingScreen {
            OnboardingDebugView(screen: screen)
        } else {
            gate
        }
        #else
        gate
        #endif
    }

    private var gate: some View {
        ZStack {
            switch session.phase {
            case .launching:
                LaunchView()
            case .signedOut:
                SignInFlow()
            case .settingUp:
                SettingUpView()
            case .onboarding(.profile):
                ProfileSetupView(initialName: session.nameHint,
                                 checkHandle: session.isHandleAvailable,
                                 save: session.saveProfile(name:handle:bio:))
            case .onboarding(.photo):
                AvatarPickerView(mode: .onboarding, current: session.snapshot?.profile,
                                 seed: session.snapshot?.profile.id ?? "", save: session.saveAvatar)
            case .onboarding(.location):
                LocationSetupView(save: session.saveLocation)
            case .onboarding(.follows):
                let api = session.socialAPI()
                FollowSuggestionsView(load: { try await api.suggested(limit: 12) },
                                      setFollowing: { try await api.setFollowing($0, $1) },
                                      done: session.finishOnboarding)
            case .ready:
                RootView()
                    .logOutConfirmation()
            case .failed(let message):
                SessionErrorView(message: message)
            }
        }
        .transition(.opacity)
        .animation(.smooth, value: session.phase)
    }
}

private struct SignInFlow: View {
    @Environment(SessionStore.self) private var session
    @State private var usingEmail = false

    private var devLogin: ((String, String) async throws -> Void)? {
        #if DEBUG
        guard session.devLoginAvailable else { return nil }
        let session = session
        return { username, password in try await session.devLogin(username: username, password: password) }
        #else
        return nil
        #endif
    }

    var body: some View {
        NavigationStack {
            WelcomeView(signIn: session.signIn(with:), useEmail: { usingEmail = true }, devLogin: devLogin)
                .navigationDestination(isPresented: $usingEmail) {
                    EmailSignInView(sendCode: session.sendEmailCode(to:),
                                    verify: session.verifyEmailCode(_:email:))
                }
        }
    }
}

/// Shown for a moment while Privy reads the saved session from the keychain.
private struct LaunchView: View {
    var body: some View {
        ThesisLoader(state: .breathing, wordmark: true)
            .accessibilityHidden(true)
    }
}

private struct SettingUpView: View {
    var body: some View {
        // A first sign-in: Privy makes the wallet, the backend makes the profile.
        ThesisLoader(lines: ["Signing you in", "Making your wallet", "Setting up your account"],
                     state: .connecting, wordmark: true)
    }
}

private struct SessionErrorView: View {
    let message: String
    @Environment(SessionStore.self) private var session

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 36))
                .foregroundStyle(Palette.muted)
            Text(message)
                .font(.geist(17))
                .multilineTextAlignment(.center)
            Spacer()
            OnboardingButton(title: "Try again") { Task { await session.retry() } }
            Button("Log out") { Task { await session.logOut() } }
                .font(.geist(15, .semibold))
                .foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(ThesisBackground())
    }
}

#if DEBUG
/// `-screen welcome|email|handle|location`: onboarding screens with stubbed actions,
/// for screenshots and UI tests. The handle "taken" is always taken.
private struct OnboardingDebugView: View {
    let screen: OnboardingDebugScreen

    var body: some View {
        switch screen {
        case .welcome:
            NavigationStack { WelcomeView(signIn: { _ in }, useEmail: {}) }
        case .email:
            NavigationStack { EmailSignInView(sendCode: { _ in }, verify: { _, _ in }) }
        case .handle:
            ProfileSetupView(initialName: "", checkHandle: { $0 != "taken" }, save: { _, handle, _ in
                if handle == "taken" { throw SessionAPIError.handleTaken }
            })
        case .location:
            LocationSetupView(save: { _, _ in })
        case .avatar:
            AvatarPickerView(mode: .onboarding, current: nil, seed: "sarah", save: { _ in })
        case .follows:
            FollowSuggestionsView(load: {
                [MockData.priya, MockData.jake, MockData.lena, MockData.mo, MockData.kai, MockData.dev]
                    .map { Suggestion(person: $0, reason: "Top caller") }
            }, setFollowing: { _, _ in }, done: {})
        }
    }
}
#endif
