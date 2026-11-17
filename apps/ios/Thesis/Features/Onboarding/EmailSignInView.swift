import SwiftUI

/// Email sign-in: enter email → we send a 6-digit code → enter it.
/// No passwords; the code is the sign-in. iOS offers to fill it from Mail.
struct EmailSignInView: View {
    var sendCode: (String) async throws -> Void
    var verify: (_ code: String, _ email: String) async throws -> Void

    @State private var email = ""
    @State private var code = ""
    @State private var sentTo: String?
    @State private var busy = false
    @State private var error: String?
    @State private var resendAvailableAt = Date.distantPast
    @FocusState private var focused: Bool

    private static let codeLength = 6
    private static let resendDelay: TimeInterval = 30

    private var emailLooksValid: Bool {
        email.trimmingCharacters(in: .whitespaces)
            .wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s]+/) != nil
    }

    var body: some View {
        Group {
            if let sentTo {
                codeStep(sentTo)
            } else {
                emailStep
            }
        }
        .animation(.snappy, value: sentTo)
        .animation(.snappy, value: error)
        .onAppear { focused = true }
        .navigationBarTitleDisplayMode(.inline)
    }

    private var emailStep: some View {
        OnboardingScaffold(title: "What's your email?", subtitle: "We'll send you a code to sign in.") {
            VStack(alignment: .leading, spacing: 14) {
                UnderlineField(placeholder: "you@example.com", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($focused)
                    .onSubmit(send)
                    .accessibilityIdentifier("email-field")
                InlineError(text: error)
            }
        } footer: {
            OnboardingButton(title: "Send code", busy: busy, action: send)
                .disabled(!emailLooksValid || busy)
                .opacity(emailLooksValid ? 1 : 0.5)
        }
    }

    private func codeStep(_ address: String) -> some View {
        OnboardingScaffold(title: "Enter the code", subtitle: "We sent a 6-digit code to \(address).") {
            VStack(alignment: .leading, spacing: 14) {
                UnderlineField(placeholder: "000000", text: $code, font: .mono(30, .medium))
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focused)
                    .accessibilityIdentifier("code-field")
                    .onChange(of: code) { _, new in
                        let digits = String(new.filter(\.isNumber).prefix(Self.codeLength))
                        if digits != new { code = digits }
                        if digits.count == Self.codeLength { submitCode() }
                    }
                InlineError(text: error)
                HStack(spacing: 18) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let wait = Int(resendAvailableAt.timeIntervalSince(context.date).rounded(.up))
                        Button(wait > 0 ? "Resend in \(wait)s" : "Resend code") { resend(address) }
                            .disabled(wait > 0 || busy)
                    }
                    Button("Use a different email") {
                        sentTo = nil
                        code = ""
                        error = nil
                    }
                }
                .font(.geist(14, .semibold))
                .foregroundStyle(Palette.text)
                .padding(.top, 6)
            }
        } footer: {
            OnboardingButton(title: "Continue", busy: busy, action: submitCode)
                .disabled(code.count != Self.codeLength || busy)
                .opacity(code.count == Self.codeLength ? 1 : 0.5)
        }
    }

    private func send() {
        guard emailLooksValid, !busy else { return }
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        perform {
            try await sendCode(address)
            sentTo = address
            code = ""
            resendAvailableAt = .now.addingTimeInterval(Self.resendDelay)
        }
    }

    private func resend(_ address: String) {
        perform {
            try await sendCode(address)
            resendAvailableAt = .now.addingTimeInterval(Self.resendDelay)
        }
    }

    private func submitCode() {
        guard let sentTo, code.count == Self.codeLength, !busy else { return }
        let entered = code
        perform(onError: { code = "" }) {
            try await verify(entered, sentTo)
        }
    }

    private func perform(onError: @escaping () -> Void = {}, _ work: @escaping () async throws -> Void) {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await work()
            } catch {
                self.error = AuthErrorText.message(for: error)
                onError()
            }
        }
    }
}
