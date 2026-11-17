import SwiftUI

/// Last onboarding step: follow a few callers so the Following feed isn't
/// empty on day one. Optional: "Skip for now" until you follow someone.
struct FollowSuggestionsView: View {
    var load: () async throws -> [Suggestion]
    var setFollowing: (_ profileID: String, _ on: Bool) async throws -> Void
    var done: () -> Void

    @State private var suggestions: [Suggestion] = []
    @State private var followed: Set<String> = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        OnboardingScaffold(title: "Follow some callers",
                           subtitle: "Their takes show up in your Following feed. You can change this anytime.") {
            VStack(spacing: 0) {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if suggestions.isEmpty {
                    Text("No one to suggest yet. You can find people in Search.")
                        .font(.geist(15))
                        .foregroundStyle(Palette.muted)
                        .padding(.top, 20)
                }
                ForEach(suggestions) { suggestion in
                    row(suggestion)
                    Hairline()
                }
                InlineError(text: error).padding(.top, 12)
            }
            .animation(.snappy, value: followed)
        } footer: {
            OnboardingButton(title: followed.isEmpty ? "Skip for now" : "Continue", action: done)
        }
        .task { await reload() }
        .navigationBarBackButtonHidden()
    }

    private func row(_ suggestion: Suggestion) -> some View {
        let person = suggestion.person
        return HStack(spacing: 12) {
            Avatar(name: person.avatar, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name).font(.geist(15, .semibold)).lineLimit(1)
                Text("\(person.handle) · \(suggestion.reason)")
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            FollowPill(name: person.name, following: followed.contains(suggestion.id)) { toggle(suggestion) }
        }
        .padding(.vertical, 10)
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            suggestions = try await load()
        } catch {
            self.error = AuthErrorText.message(for: error)
        }
    }

    /// Optimistic; reverts if the server says no.
    private func toggle(_ suggestion: Suggestion) {
        let on = !followed.contains(suggestion.id)
        if on { followed.insert(suggestion.id) } else { followed.remove(suggestion.id) }
        error = nil
        Task {
            do {
                try await setFollowing(suggestion.id, on)
            } catch {
                if on { followed.remove(suggestion.id) } else { followed.insert(suggestion.id) }
                self.error = AuthErrorText.message(for: error)
            }
        }
    }
}
