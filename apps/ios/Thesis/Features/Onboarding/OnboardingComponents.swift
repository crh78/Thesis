import SwiftUI

/// Shared layout for onboarding steps: big title, muted subtitle, content,
/// and the primary action pinned above the keyboard.
struct OnboardingScaffold<Content: View, Footer: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.geist(30, .bold))
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle)
                        .font(.geist(16))
                        .foregroundStyle(Palette.muted)
                        .padding(.top, 8)
                }
                content.padding(.top, 28)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) { footer }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
        }
        .background(ThesisBackground())
    }
}

/// Large borderless text field with a hairline underneath (sectionless, no boxes).
struct UnderlineField: View {
    let placeholder: String
    @Binding var text: String
    var prefix: String? = nil
    var font: Font = .geist(22, .medium)

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 2) {
                if let prefix {
                    Text(prefix).foregroundStyle(Palette.muted)
                }
                TextField(placeholder, text: $text)
            }
            .font(font)
            Hairline()
        }
    }
}

/// Full-width capsule action. `.filled` is high-contrast (Apple's button);
/// `.glass` matches the app's primary buttons.
struct OnboardingButton: View {
    enum Style { case filled, glass }

    let title: String
    var systemImage: String? = nil
    /// Full-color asset (e.g. a brand mark), shown as-is instead of `systemImage`.
    var image: String? = nil
    var style: Style = .glass
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if busy {
                    ProgressView().tint(style == .filled ? Palette.bg : Palette.text)
                } else {
                    if let image {
                        Image(image)
                            .resizable()
                            .renderingMode(.original)
                            .scaledToFit()
                            .frame(width: 20, height: 20)
                            .accessibilityHidden(true)
                    } else if let systemImage {
                        Image(systemName: systemImage)
                    }
                    Text(title)
                }
            }
            .font(.geist(17, .semibold))
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(style == .filled ? Palette.bg : Palette.text)
            .background(style == .filled ? Palette.text : .clear, in: .capsule)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .modifier(GlassIf(enabled: style == .glass))
        .accessibilityLabel(title)
    }
}

private struct GlassIf: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            content
        }
    }
}

struct InlineError: View {
    let text: String?

    var body: some View {
        if let text {
            Label(text, systemImage: "exclamationmark.circle")
                .font(.geist(14))
                .foregroundStyle(Palette.down)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity)
        }
    }
}
