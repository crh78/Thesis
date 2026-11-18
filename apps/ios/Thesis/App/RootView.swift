import SwiftUI
import ThinkingOrbsKit

enum AppTab: Hashable {
    case home, scores, me, search
}

/// iOS 26 Liquid Glass tab bar: Home, Scores, Me, with Search as the separate
/// round button. "What's your take?" lives in the bottom accessory above it.
/// On Home, swiping right (or tapping your avatar) opens the profile sidebar.
struct RootView: View {
    @Environment(AppState.self) private var app
    @Environment(SessionStore.self) private var session
    @State private var composing = false
    @State private var composerActive = false
    @State private var composeText = ""
    @State private var startingWithCash = false
    /// The take a link opened, shown once this screen is up (see `showLinkedTake`).
    @State private var linkedTake: TakeReceiptLink?

    private var canStart: Bool { !composeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func startTake() {
        guard canStart else { return }
        composerActive = false
        composing = true
    }

    var body: some View {
        #if DEBUG
        if let route = DebugRoute.current, route.tab == nil {
            DebugScreen(route: route)
        } else {
            shell.onAppear {
                if let t = DebugRoute.current?.tab { app.tab = t }
                if DebugRoute.current == .drawer { app.drawerOpen = true }
            }
        }
        #else
        shell
        #endif
    }

    private var shell: some View {
        @Bindable var app = app
        return SidebarContainer(isOpen: $app.drawerOpen, swipeEnabled: app.sidebarSwipeEnabled, pull: app.sidebarPull) {
            tabs
        } sidebar: {
            ProfileDrawer()
        }
        .overlay(alignment: .bottom) {
            if composerActive {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.35)
                        .ignoresSafeArea()
                        .onTapGesture { composerActive = false }
                        .accessibilityHidden(true)
                    ComposerBar(text: $composeText, canStart: canStart, onStart: startTake) {
                        composerActive = false
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.22), value: composerActive)
        .overlay(alignment: .top) { ErrorBanner() }
        .task { await connect() }
        .onChange(of: session.snapshot?.profile) { _, profile in
            if let profile { app.updateMe(from: profile) }
        }
        .onDisappear { app.disconnect() }
    }

    private func showLinkedTake() async {
        guard let receipt = app.openedReceipt else { return }
        composing = false
        composerActive = false
        startingWithCash = false
        app.drawerOpen = false
        app.showAddCash = false
        app.showWithdraw = false
        app.showCash = false
        if linkedTake != nil { linkedTake = nil }
        Self.dismissPresented()
        try? await Task.sleep(for: .milliseconds(600))
        guard !Task.isCancelled else { return }
        linkedTake = receipt
        // Cleared last: this task is keyed on it, so clearing it earlier would cancel the wait.
        app.openedReceipt = nil
    }

    /// Closes any sheet or cover still on screen (ones this view doesn't own, like a trade sheet).
    private static func dismissPresented() {
        let root = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }
            .first
        if root?.presentedViewController != nil { root?.dismiss(animated: false) }
    }

    /// Signed in: load real data. UI tests and previews stay on mock data.
    private func connect() async {
        #if DEBUG
        if LaunchFlags.skipsAuth { return }
        #endif
        guard let profile = session.snapshot?.profile else { return }
        let session = session
        // Money only runs on the fork, from your wallet. No wallet yet (making it failed at
        // sign-in): say so, and Try again makes it again.
        guard let fork = await session.forkAPI() else {
            session.walletMissing()
            return
        }
        await app.connect(api: SocialAPI(token: { try await session.accessToken() }), profile: profile, fork: fork)
        // Just finished onboarding: offer Add cash once (after connecting, so a
        // deposit goes to the real balance).
        if session.finishedOnboarding {
            session.finishedOnboarding = false
            startingWithCash = true
        }
    }

    private var tabs: some View {
        @Bindable var app = app
        return TabView(selection: $app.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                FeedView()
            }
            Tab("Scores", systemImage: "trophy", value: AppTab.scores) {
                ScoresView()
            }
            Tab("Me", systemImage: "person.crop.circle", value: AppTab.me) {
                ProfileView()
            }
            Tab(value: AppTab.search, role: .search) {
                SearchView()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            NewTakeAccessory(draft: composeText, canStart: canStart,
                             onEdit: { composerActive = true }, onStart: startTake)
        }
        .fullScreenCover(isPresented: $composing, onDismiss: { composeText = "" }) {
            CreateFlow(initialClaim: composeText)
        }
        .fullScreenCover(item: $app.openedTake) { take in
            CreateFlow(link: take)
        }
        .fullScreenCover(item: $app.seededTake) { asset in
            CreateFlow(seed: asset)
        }
        .sheet(item: $linkedTake) { receipt in
            LinkedTakeReceipt(id: receipt.id)
        }
        // A take link (from the web app, or a chat) can arrive while the app is still starting,
        // or while another sheet is up: either way iOS would drop the sheet. Wait until this
        // screen is in place, close whatever is open, then show the take.
        .task(id: app.openedReceipt?.id) { await showLinkedTake() }
        .sheet(isPresented: $app.showAddCash) {
            AddCashView()
        }
        .sheet(isPresented: $app.showWithdraw) {
            WithdrawView()
        }
        .sheet(isPresented: $app.showCash) {
            CashSheet()
        }
        .fullScreenCover(isPresented: $startingWithCash) {
            StartWithCashView()
        }
    }
}

private struct LinkedTakeReceipt: View {
    @Environment(AppState.self) private var app
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var take: Take?
    @State private var loading = true
    let id: String

    var body: some View {
        NavigationStack {
            Group {
                if let take { TakeDetailView(take: take) }
                else if loading {
                    ThesisLoader(lines: ["Opening the take", "Reading the on-chain receipt"], state: .searching)
                }
                else { ContentUnavailableView("Take unavailable", systemImage: "doc") }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            take = app.loadedTake(id)
            if take == nil {
                let session = session
                take = try? await SocialAPI(token: { try await session.accessToken() }).take(id: id)
            }
            loading = false
        }
    }
}

/// Slide-out sidebar from the leading edge that tracks your finger. Swipe
/// right to open (when enabled), swipe left or tap the dimmed content to close.
private struct SidebarContainer<Content: View, Sidebar: View>: View {
    @Binding var isOpen: Bool
    let swipeEnabled: Bool
    /// External pull (from Home's pager), in page widths.
    var pull: CGFloat = 0
    @ViewBuilder let content: Content
    @ViewBuilder let sidebar: Sidebar

    @State private var drag: CGFloat = 0
    /// Whether the current drag began somewhere a swipe may open the sidebar.
    @State private var armed: Bool?
    private let width: CGFloat = 300

    /// 0 = closed, 1 = open.
    private var progress: CGFloat {
        let base: CGFloat = isOpen ? width : 0
        return min(max((base + drag) / width + pull * 3.5, 0), 1)
    }

    var body: some View {
        ZStack(alignment: .leading) {
            content
                .simultaneousGesture(openGesture)

            Color.black
                .opacity(0.5 * progress)
                .ignoresSafeArea()
                .allowsHitTesting(progress > 0)
                .onTapGesture { close() }
                .gesture(closeGesture)
                .accessibilityHidden(!isOpen)

            // Only in the hierarchy while visible, so VoiceOver (and UI tests)
            // don't find an off-screen sidebar.
            if isOpen || drag != 0 || pull > 0 {
                sidebar
                    .offset(x: -width + width * progress)
                    .gesture(closeGesture)
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.smooth(duration: 0.28), value: isOpen)
    }

    private func close() {
        isOpen = false
        drag = 0
    }

    private var openGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                if armed == nil { armed = swipeEnabled && !isOpen }
                guard armed == true else { return }
                let dx = value.translation.width
                guard dx > 0, abs(dx) > abs(value.translation.height) * 1.4 else { return }
                drag = min(dx, width)
            }
            .onEnded { value in
                defer { armed = nil }
                guard armed == true else { return }
                let dx = value.translation.width
                let fling = value.predictedEndTranslation.width
                let horizontal = abs(dx) > abs(value.translation.height) * 1.4
                withAnimation(.smooth(duration: 0.28)) {
                    if horizontal && (dx > width * 0.35 || fling > width * 0.6) { isOpen = true }
                    drag = 0
                }
            }
    }

    private var closeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                drag = min(0, value.translation.width)
            }
            .onEnded { value in
                withAnimation(.smooth(duration: 0.28)) {
                    if value.translation.width < -width * 0.3 || value.predictedEndTranslation.width < -width * 0.5 {
                        isOpen = false
                    }
                    drag = 0
                }
            }
    }
}

/// The bar above the tabs. Shows your draft (or the prompt); tapping it opens
/// the compose bar above the keyboard. The arrow only works once you've typed.
private struct NewTakeAccessory: View {
    let draft: String
    let canStart: Bool
    let onEdit: () -> Void
    let onStart: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onEdit) {
                HStack(spacing: 10) {
                    ThinkingOrb(state: .breathing, size: .px20)
                    Text(draft.isEmpty ? "What's your take?" : draft)
                        .font(.geist(15, .medium))
                        .foregroundStyle(draft.isEmpty ? Palette.muted : Palette.text)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Your take")
            .accessibilityValue(draft)
            .accessibilityHint("Write a take")

            StartArrow(enabled: canStart, action: onStart)
                .accessibilityIdentifier("accessory-start")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
    }
}

/// Glass compose bar that rides above the keyboard. Return or the arrow opens
/// the new-take flow, but only if there's text; otherwise it just closes.
private struct ComposerBar: View {
    @Binding var text: String
    let canStart: Bool
    let onStart: () -> Void
    let onClose: () -> Void
    @FocusState private var focused: Bool
    @Environment(AppState.self) private var app

    var body: some View {
        HStack(spacing: 10) {
            ThinkingOrb(state: .composing, size: .px20)
            TextField("What's your take?", text: $text)
                .font(.serif(19))
                .focused($focused)
                .submitLabel(.next)
                .onSubmit { canStart ? onStart() : onClose() }
                .accessibilityLabel("Your take")
            StartArrow(enabled: canStart, action: onStart)
                .accessibilityIdentifier("composer-start")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onAppear {
            focused = true
            app.warmTakeBuilder() // you're writing a take: wake the builder now
        }
    }
}

/// A failed save / follow / like, shown for a few seconds at the top.
private struct ErrorBanner: View {
    @Environment(AppState.self) private var app

    var body: some View {
        if let message = app.actionError {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.geist(14, .medium))
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .glassEffect(.regular, in: .capsule)
                .padding(.top, 4)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { app.actionError = nil }
                .task(id: message) {
                    try? await Task.sleep(for: .seconds(3))
                    withAnimation(.smooth) { app.actionError = nil }
                }
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

private struct StartArrow: View {
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(enabled ? Palette.bg : Palette.muted)
                .frame(width: 30, height: 30)
                .background(enabled ? Palette.text : Palette.tile, in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .animation(.snappy, value: enabled)
        .accessibilityLabel("Start take")
    }
}
