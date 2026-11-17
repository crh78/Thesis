import SwiftUI

/// Fork mode: your take while its on-chain buy-in confirms. Nobody else sees the take until then.
/// "Posting…", then either it goes live (and this disappears), or "Didn't post" with Retry and
/// Discard, or (on-chain but not showing yet) "Check again".
struct PostingBar: View {
    @Environment(AppState.self) private var app
    let take: Take
    @State private var confirmDiscard = false
    @State private var discarding = false

    var body: some View {
        HStack(spacing: 10) {
            switch app.postStates[take.id] ?? .posting {
            case .posting:
                ProgressView().controlSize(.small)
                Text("Posting… only you can see it")
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                Spacer(minLength: 0)
            case .failed(let why):
                status("Didn't post", why, icon: "exclamationmark.circle", color: Palette.down)
                Button("Discard") { confirmDiscard = true }
                    .font(.geist(13, .semibold))
                    .foregroundStyle(Palette.down)
                    .disabled(discarding)
                    .accessibilityIdentifier("posting-discard")
                Button("Retry") { app.retryPost(take) }
                    .font(.geist(13, .semibold))
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("posting-retry")
            case .unconfirmed:
                status("On-chain, not showing yet", "Your buy-in landed; the feed hasn't caught up.",
                       icon: "clock", color: Palette.muted)
                Button("Check again") { app.retryPost(take) }
                    .font(.geist(13, .semibold))
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("posting-check")
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("posting-bar")
        .confirmationDialog("Discard this take?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                discarding = true
                Task {
                    await app.discardPost(take)
                    discarding = false
                }
            }
        } message: {
            Text("It never made it on-chain, so nobody saw it and no money moved.")
        }
    }

    private func status(_ title: String, _ detail: String, icon: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.geist(13, .semibold)).foregroundStyle(Palette.text)
                Text(detail).font(.geist(12)).foregroundStyle(Palette.muted).lineLimit(2)
            }
            Spacer(minLength: 4)
        }
    }
}
