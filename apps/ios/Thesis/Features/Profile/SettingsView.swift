import SwiftUI

/// Settings, from the profile sidebar: appearance, who can see your follow
/// lists, and deleting your account.
struct SettingsView: View {
    @Environment(AppState.self) private var app
    @Environment(SessionStore.self) private var session
    @AppStorage("appearance") private var appearance: Appearance = .dark

    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var deleteError: String?

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                }
                .accessibilityIdentifier("settings-appearance")
            }

            Section {
                Toggle("Show who you follow", isOn: privacyBinding(\.showFollowing))
                    .accessibilityIdentifier("settings-show-following")
                Toggle("Show your followers", isOn: privacyBinding(\.showFollowers))
                    .accessibilityIdentifier("settings-show-followers")
            } header: {
                Text("Privacy")
            } footer: {
                Text("When a list is off, only you can see it. Your follower and following counts stay visible.")
            }

            Section {
                Button(role: .destructive) {
                    confirmingDelete = true
                } label: {
                    HStack {
                        Text("Delete account")
                        Spacer()
                        if deleting { ProgressView() }
                    }
                }
                .disabled(deleting || !app.isLive)
                .accessibilityIdentifier("settings-delete-account")
            } header: {
                Text("Account")
            } footer: {
                if let deleteError {
                    Text(deleteError).foregroundStyle(Palette.down)
                } else {
                    Text("Deletes your profile, takes, comments, follows and cash for good. This can't be undone.")
                }
            }
        }
        .font(.geist(16))
        .tint(Palette.up)
        .scrollContentBackground(.hidden)
        .background(ThesisBackground())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Delete your account?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive) { delete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your profile, takes, comments, follows and cash will be gone for good.")
        }
    }

    private func privacyBinding(_ key: WritableKeyPath<FollowPrivacy, Bool>) -> Binding<Bool> {
        Binding(
            get: { app.privacy[keyPath: key] },
            set: { on in
                var next = app.privacy
                next[keyPath: key] = on
                app.setPrivacy(next)
            }
        )
    }

    private func delete() {
        deleteError = nil
        deleting = true
        Task {
            defer { deleting = false }
            do {
                try await session.deleteAccount() // signs out: the app goes back to Welcome
            } catch {
                deleteError = (error as? LocalizedError)?.errorDescription ?? "Couldn't delete your account. Try again."
            }
        }
    }
}
