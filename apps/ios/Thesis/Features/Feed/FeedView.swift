import SwiftUI

struct TradeIntent: Identifiable {
    let take: Take
    let side: Side
    var id: String { take.id + side.rawValue }
}

struct FeedView: View {
    @Environment(AppState.self) private var app
    @State private var showInbox = false
    @State private var trade: TradeIntent?
    @State private var commentsFor: Take?

    /// Which page the native pager is on, and how far between pages it is
    /// (0 = For you, 1 = Following) so the tab underline follows the finger.
    @State private var pagePosition: FeedPage? = .forYou
    @State private var scrollProgress: CGFloat = 0

    private var progress: CGFloat { min(max(scrollProgress, 0), 1) }

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.homePath) {
            VStack(spacing: 0) {
                FeedPageTabs(page: $app.feedPage, progress: progress)
                Hairline()
                pager
            }
            .background(ThesisBackground())
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .peopleDestinations()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProfileMenuButton()
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .principal) {
                    Text("thesis").font(.pixel(24))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showInbox = true } label: {
                        Image(systemName: app.unreadNotifications > 0 ? "bell.badge" : "bell")
                            .symbolRenderingMode(.multicolor)
                    }
                    .accessibilityLabel(app.unreadNotifications > 0 ? "Notifications, \(app.unreadNotifications) unread" : "Notifications")
                    .accessibilityIdentifier("open-notifications")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { app.addCash() } label: {
                        HStack(spacing: 6) {
                            Text(Fmt.usd(app.balance, cents: true)).font(.mono(13, .semibold))
                                .contentTransition(.numericText())
                            Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                        }
                    }
                    .accessibilityLabel("Balance \(Fmt.usd(app.balance, cents: true)). Add cash")
                }
            }
        }
        .sheet(item: $trade) { TradeSheet(intent: $0) }
        .sheet(isPresented: $showInbox) { NotificationsView() }
        .sheet(item: $commentsFor) { CommentsView(take: $0) }
        .sensoryFeedback(.selection, trigger: app.feedPage)
    }

    // MARK: Pager

    /// The two feeds in a native paging scroll view (so a swipe that starts on
    /// a button scrolls instead of tapping it). Swipe left for Following,
    /// right to come back. Pulling past the left edge of For you drags the
    /// profile sidebar open.
    private var pager: some View {
        // Pages are sized to exactly the space under the tabs (sizing them to
        // the container hid the top post under the header). The pager runs
        // under the tab bar; each feed pads its bottom so the last post clears it.
        GeometryReader { geo in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(FeedPage.allCases, id: \.self) { page in
                        feedList(page)
                            .contentMargins(.bottom, geo.safeAreaInsets.bottom, for: .scrollContent)
                            .frame(width: geo.size.width, height: geo.size.height)
                            .id(page)
                            .accessibilityHidden(page != app.feedPage)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
        .scrollIndicators(.hidden)
        .scrollPosition(id: $pagePosition)
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            geo.contentOffset.x / max(geo.containerSize.width, 1)
        } action: { _, value in
            scrollProgress = value
            // Rubber-band past the left edge of For you → sidebar follows.
            app.sidebarPull = app.feedPage == .forYou ? max(0, -value) : 0
        }
        .onScrollPhaseChange { old, new in
            guard old == .interacting, new != .interacting else { return }
            if app.sidebarPull > 0.12 {
                withAnimation(.smooth(duration: 0.28)) { app.drawerOpen = true }
            }
            app.sidebarPull = 0
        }
        .onChange(of: pagePosition) { _, page in
            if let page, page != app.feedPage { app.feedPage = page }
        }
        .onChange(of: app.feedPage) { _, page in
            if pagePosition != page { withAnimation(.snappy(duration: 0.32)) { pagePosition = page } }
        }
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private func feedList(_ page: FeedPage) -> some View {
        let takes = page == .forYou ? app.forYou : app.followingFeed
        return ScrollView {
            LazyVStack(spacing: 0) {
                if page == .following && !app.suggested.isEmpty {
                    SuggestedFollowsList().padding(.vertical, 12)
                    Hairline()
                }
                ForEach(takes) { take in
                    TakeRow(take: take,
                            onTrade: { trade = TradeIntent(take: take, side: $0) },
                            onComments: { commentsFor = take })
                    Hairline()
                }
                if takes.isEmpty {
                    emptyState(page).padding(.top, 60)
                }
            }
            .padding(.bottom, 24)
        }
        .refreshable { await app.refresh() }
    }

    @ViewBuilder private func emptyState(_ page: FeedPage) -> some View {
        switch (page, app.feedState) {
        case (.forYou, .loading), (.forYou, .idle) where app.isLive:
            ThesisLoader(lines: ["Loading takes", "Pulling the latest prices"], state: .weaving, fullScreen: false)
                .frame(height: 260)
        case (.forYou, .failed(let message)):
            ContentUnavailableView {
                Label("Couldn't load takes", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await app.refresh() } }
                    .buttonStyle(.glass)
            }
        case (.forYou, _):
            ContentUnavailableView("No takes yet", systemImage: "text.bubble",
                                   description: Text("Be the first: tap What's your take?"))
        case (.following, _):
            ContentUnavailableView("No takes yet", systemImage: "person.2",
                                   description: Text("Follow callers to see their takes here."))
        }
    }
}

/// X-style "For you / Following" header whose underline slides with the swipe.
private struct FeedPageTabs: View {
    @Binding var page: FeedPage
    let progress: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            ForEach(FeedPage.allCases, id: \.self) { item in
                let active = (progress < 0.5) == (item == .forYou)
                Button {
                    withAnimation(.snappy(duration: 0.32)) { page = item }
                } label: {
                    Text(item.title)
                        .font(.geist(15, active ? .semibold : .medium))
                        .foregroundStyle(active ? Palette.text : Palette.muted)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(item == page ? .isSelected : [])
            }
        }
        .overlay(alignment: .bottomLeading) {
            GeometryReader { geo in
                let half = geo.size.width / 2
                Capsule()
                    .fill(Palette.text)
                    .frame(width: 56, height: 3)
                    .offset(x: half * progress + (half - 56) / 2, y: geo.size.height - 3)
            }
            .allowsHitTesting(false)
        }
    }
}

/// X-style row: avatar column, then the take. The claim + chart open the take
/// page; the actions sit outside the link.
struct TakeRow: View {
    @Environment(AppState.self) private var app
    let take: Take
    var onTrade: (Side) -> Void
    var onComments: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            PersonLink(person: take.author) { Avatar(name: take.author.avatar, size: 42) }

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 5) {
                    PersonLink(person: take.author) {
                        HStack(spacing: 5) {
                            Text(take.author.name).font(.geist(15, .semibold))
                            Text(take.author.handle(then: take.age)).font(.geist(15)).foregroundStyle(Palette.muted)
                        }
                    }
                    Spacer(minLength: 4)
                    Text(take.tag).font(.mono(11)).foregroundStyle(Palette.muted)
                }
                .lineLimit(1)

                NavigationLink(value: take) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(take.claim)
                            .font(.serif(24))
                            .foregroundStyle(Palette.text)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(alignment: .bottom) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(Fmt.pct(take.ret))
                                    .font(.geist(26, .bold))
                                    .monospacedDigit()
                                    .foregroundStyle(Palette.sign(pct: take.ret))
                                Text("since \(take.since)").font(.mono(11)).foregroundStyle(Palette.muted)
                            }
                            Spacer()
                            Sparkline(values: take.history, color: Palette.sign(pct: take.ret))
                                .frame(width: 130, height: 36)
                        }

                        AllocationBar(legs: take.legs)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // Not public yet: nothing to open, trade, comment on or share.
                .disabled(take.posting)

                if take.posting {
                    PostingBar(take: take)
                } else {
                    actions
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 6)
    }

    private var actions: some View {
        // Must fit the column: fixed-size pills + icons that overflow
        // make SwiftUI widen the whole row and shift it off-screen.
        // Pills on the left; comments / save / share as one evenly
        // spaced group on the right.
        HStack(spacing: 8) {
            if take.isOpen {
                CompactSidePill(side: .back, count: take.backs) { onTrade(.back) }
                // You can't fade your own take.
                if !app.isMe(take.author) {
                    CompactSidePill(side: .fade, count: take.fades) { onTrade(.fade) }
                }
            } else {
                // Its author sold: no new trades or fades.
                Text(take.closedReason)
                    .font(.geist(13, .medium))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .frame(minHeight: 34)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                Button(action: onComments) {
                    HStack(spacing: 4) {
                        Image(systemName: "bubble.left")
                        Text("\(take.comments)").font(.mono(12))
                    }
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundStyle(Palette.muted)
                    .frame(minWidth: 36, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(take.comments) comments")
                SaveButton(take: take)
                ShareCardButton(take: take) {
                    Image(systemName: "square.and.arrow.up")
                        .foregroundStyle(Palette.muted)
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .font(.system(size: 15))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
