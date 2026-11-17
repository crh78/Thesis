import SwiftUI

/// First screen for signed-out users: what Thesis is, and the ways to sign in.
struct WelcomeView: View {
    var signIn: (SocialProvider) async throws -> Void
    var useEmail: () -> Void
    /// Debug builds only; `nil` hides the link.
    var devLogin: ((_ username: String, _ password: String) async throws -> Void)? = nil

    @State private var busy: SocialProvider?
    @State private var error: String?
    @State private var showingDevLogin = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("thesis")
                    .font(.pixel(28))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if devLogin != nil {
                    Button("Dev login") { showingDevLogin = true }
                        .font(.mono(12, .medium))
                        .foregroundStyle(Palette.muted)
                }
            }
            .padding(.top, 8)
            TakeStoryHero()
                .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                .padding(.vertical, 24)
            Text("Turn ideas\ninto markets.")
                .font(.serif(38))
                .fixedSize(horizontal: false, vertical: true)
            Text("Make a market. Make it yours. Share your take, follow others, and trade any idea long or short.")
                .font(.geist(16))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
                .padding(.bottom, 28)

            VStack(spacing: 12) {
                InlineError(text: error)
                if AppConfig.appleSignInEnabled {
                    OnboardingButton(title: "Continue with Apple", systemImage: "apple.logo", style: .filled,
                                     busy: busy == .apple) { run(.apple) }
                }
                OnboardingButton(title: "Continue with Google", image: "google-g",
                                 style: AppConfig.appleSignInEnabled ? .glass : .filled,
                                 busy: busy == .google) { run(.google) }
                OnboardingButton(title: "Continue with email", systemImage: "envelope") { useEmail() }
            }
            .disabled(busy != nil)
            .animation(.snappy, value: error)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .background(AuroraBackground())
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingDevLogin) {
            if let devLogin { DevLoginSheet(login: devLogin) }
        }
    }

    private func run(_ provider: SocialProvider) {
        error = nil
        busy = provider
        Task {
            defer { busy = nil }
            do {
                try await signIn(provider)
            } catch {
                self.error = AuthErrorText.message(for: error)
            }
        }
    }
}

/// Debug-only username/password sign-in to the shared dev (Privy test) account.
private struct DevLoginSheet: View {
    let login: (_ username: String, _ password: String) async throws -> Void

    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    @Environment(\.dismiss) private var dismiss

    private enum Field { case username, password }
    private var canSubmit: Bool { !username.isEmpty && !password.isEmpty && !busy }

    var body: some View {
        NavigationStack {
            OnboardingScaffold(title: "Dev login", subtitle: "Debug builds only. Signs in to the shared test account.") {
                VStack(alignment: .leading, spacing: 22) {
                    UnderlineField(placeholder: "Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focus, equals: .username)
                        .onSubmit { focus = .password }
                        .accessibilityIdentifier("dev-username")
                    VStack(spacing: 10) {
                        SecureField("Password", text: $password)
                            .font(.geist(22, .medium))
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focus, equals: .password)
                            .onSubmit(submit)
                            .accessibilityIdentifier("dev-password")
                        Hairline()
                    }
                    InlineError(text: error)
                }
            } footer: {
                OnboardingButton(title: "Log in", busy: busy, action: submit)
                    .disabled(!canSubmit)
                    .opacity(canSubmit ? 1 : 0.5)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .onAppear { focus = .username }
    }

    private func submit() {
        guard canSubmit else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await login(username, password)
                dismiss()
            } catch {
                self.error = AuthErrorText.message(for: error)
            }
        }
    }
}
