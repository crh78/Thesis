import SwiftUI

/// Onboarding step 1: display name, @handle (checked live) and an optional bio.
struct ProfileSetupView: View {
    var initialName: String
    var checkHandle: (String) async -> Bool?
    var save: (_ name: String, _ handle: String, _ bio: String) async throws -> Void

    static let bioLimit = 160

    @State private var name = ""
    @State private var handle = ""
    @State private var bio = ""
    @State private var handleEdited = false
    @State private var status: HandleStatus = .idle
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case name, handle, bio }

    enum HandleStatus: Equatable {
        case idle, tooShort, checking, available, taken, unknown
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var canContinue: Bool {
        !trimmedName.isEmpty && trimmedName.count <= 50 && handle.count >= 3
            && status != .taken && status != .checking && bio.count <= Self.bioLimit && !busy
    }

    var body: some View {
        OnboardingScaffold(title: "Make your profile", subtitle: "This is how friends find you and see your calls.") {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    label("Name")
                    UnderlineField(placeholder: "Your name", text: $name)
                        .textContentType(.name)
                        .submitLabel(.next)
                        .focused($focus, equals: .name)
                        .onSubmit { focus = .handle }
                        .accessibilityIdentifier("name-field")
                }
                VStack(alignment: .leading, spacing: 8) {
                    label("Handle")
                    UnderlineField(placeholder: "handle", text: $handle, prefix: "@")
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focus, equals: .handle)
                        .onSubmit { focus = .bio }
                        .accessibilityIdentifier("handle-field")
                    statusLine
                }
                VStack(alignment: .leading, spacing: 8) {
                    label("Bio · optional")
                    VStack(spacing: 10) {
                        TextField("A line about what you call", text: $bio, axis: .vertical)
                            .font(.geist(18, .medium))
                            .lineLimit(1...4)
                            // Bios are often all lowercase: don't force a capital.
                            .textInputAutocapitalization(.never)
                            .focused($focus, equals: .bio)
                            .accessibilityIdentifier("bio-field")
                        Hairline()
                    }
                    Text("\(bio.count)/\(Self.bioLimit)")
                        .font(.mono(11))
                        .foregroundStyle(bio.count > Self.bioLimit ? Palette.down : Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                InlineError(text: error)
            }
        } footer: {
            OnboardingButton(title: "Continue", busy: busy, action: submit)
                .disabled(!canContinue)
                .opacity(canContinue ? 1 : 0.5)
        }
        .onAppear {
            if name.isEmpty { name = initialName }
            if handle.isEmpty { handle = Self.sanitize(initialName) }
            focus = initialName.isEmpty ? .name : .handle
        }
        .onChange(of: name) { _, new in
            // Suggest a handle from the name until the user types their own.
            if !handleEdited { handle = Self.sanitize(new) }
        }
        .onChange(of: handle) { _, new in
            // Clean up after the edit lands (rewriting inside the binding's setter
            // doesn't reliably redraw the field).
            let clean = Self.sanitize(new)
            if clean != new {
                handle = clean
            } else if focus == .handle {
                handleEdited = true
            }
        }
        .onChange(of: bio) { _, new in
            if new.count > Self.bioLimit { bio = String(new.prefix(Self.bioLimit)) }
        }
        .task(id: handle) { await check(handle) }
        .animation(.snappy, value: status)
        .animation(.snappy, value: error)
        .navigationBarBackButtonHidden()
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased()).font(.mono(11)).foregroundStyle(Palette.muted)
    }

    @ViewBuilder private var statusLine: some View {
        let (text, color): (String, Color) = switch status {
        case .idle, .unknown: ("Letters, numbers and underscores.", Palette.muted)
        case .tooShort: ("At least 3 characters.", Palette.muted)
        case .checking: ("Checking…", Palette.muted)
        case .available: ("@\(handle) is available", Palette.up)
        case .taken: ("@\(handle) is taken", Palette.down)
        }
        Text(text)
            .font(.geist(13))
            .foregroundStyle(color)
            .accessibilityIdentifier("handle-status")
    }

    private func check(_ candidate: String) async {
        guard candidate.count >= 3 else {
            status = candidate.isEmpty ? .idle : .tooShort
            return
        }
        status = .checking
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        switch await checkHandle(candidate) {
        case true?: status = .available
        case false?: status = .taken
        case nil: status = .unknown
        }
    }

    private func submit() {
        guard canContinue else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await save(trimmedName, handle, bio.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch SessionAPIError.handleTaken {
                status = .taken
            } catch {
                self.error = AuthErrorText.message(for: error)
            }
        }
    }

    /// Mirrors the backend rule `^[a-z0-9_]{3,20}$`.
    static func sanitize(_ raw: String) -> String {
        let folded = raw.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        let allowed = folded.map { $0 == " " || $0 == "-" || $0 == "." ? "_" : $0 }
            .filter { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" }
        return String(String(allowed).prefix(20))
    }
}
