import SwiftUI
import ThinkingOrbsKit

/// What a wait looks like: the thinking orb, and a line that moves on as the wait goes on
/// ("Signing you in" → "Making your wallet" → …). It stops on the last line rather than looping,
/// so a slow load never reads like it started over.
struct ThesisLoader: View {
    var lines: [String] = []
    var state: OrbState = .working
    /// The pixel "thesis" wordmark above the orb (launch and sign-in).
    var wordmark = false
    /// Fills the screen with the app background; off inside a sheet or a list.
    var fullScreen = true
    var stepSeconds: Double = 1.4

    @State private var index = 0

    var body: some View {
        let content = VStack(spacing: 20) {
            if wordmark {
                Text("thesis")
                    .font(.pixel(40))
                    .foregroundStyle(Palette.text)
            }
            ThinkingOrb(state: state, size: .px64)
            if !lines.isEmpty {
                Text(lines[min(index, lines.count - 1)])
                    .font(.geist(16))
                    .foregroundStyle(Palette.muted)
                    .id(index)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 8)),
                                            removal: .opacity.combined(with: .offset(y: -8))))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(lines.last ?? "Loading")
        .task {
            guard lines.count > 1 else { return }
            while index < lines.count - 1 {
                try? await Task.sleep(for: .seconds(stepSeconds))
                guard !Task.isCancelled else { return }
                withAnimation(.smooth(duration: 0.35)) { index += 1 }
            }
        }

        if fullScreen {
            content.background(ThesisBackground())
        } else {
            content
        }
    }
}

/// A small inline wait (a quote, a list loading): the orb at 20 px beside a short line.
struct ThesisInlineLoader: View {
    var text: String
    var state: OrbState = .working

    var body: some View {
        HStack(spacing: 10) {
            ThinkingOrb(state: state, size: .px20)
            Text(text).font(.geist(14)).foregroundStyle(Palette.muted)
        }
        .accessibilityElement(children: .combine)
    }
}
