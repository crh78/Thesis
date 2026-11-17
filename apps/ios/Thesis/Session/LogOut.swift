import SwiftUI

extension View {
    /// Hosts the one "Log out of Thesis?" confirmation. Applied once, around the
    /// app (AppGate); Log out buttons anywhere just set `session.logOutRequested`.
    /// (A dialog attached inside the sidebar container doesn't present.)
    /// Confirming also resets app navigation, so the next person to sign in
    /// starts on Home with the sidebar closed.
    func logOutConfirmation() -> some View {
        modifier(LogOutConfirmation())
    }
}

private struct LogOutConfirmation: ViewModifier {
    @Environment(SessionStore.self) private var session
    @Environment(AppState.self) private var app

    func body(content: Content) -> some View {
        @Bindable var session = session
        content.confirmationDialog("Log out of Thesis?", isPresented: $session.logOutRequested, titleVisibility: .visible) {
            Button("Log out", role: .destructive) {
                app.drawerOpen = false
                app.tab = .home
                app.homePath = NavigationPath()
                Task { await session.logOut() }
            }
        } message: {
            Text("You can sign back in anytime.")
        }
    }
}

/// Full-width "Log out" row for the bottom of the profile and the sidebar.
struct LogOutRow: View {
    var horizontalPadding: CGFloat = 24
    @Environment(SessionStore.self) private var session

    var body: some View {
        Button { session.logOutRequested = true } label: {
            HStack(spacing: 14) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 18))
                    .frame(width: 26)
                Text("Log out").font(.geist(16, .semibold))
                Spacer()
            }
            .foregroundStyle(Palette.down)
            .padding(.horizontal, horizontalPadding)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Log out")
        .accessibilityIdentifier("log-out")
    }
}
