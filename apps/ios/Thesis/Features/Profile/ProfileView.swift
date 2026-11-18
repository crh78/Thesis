import SwiftUI

private enum ProfileTab: Hashable { case positions, takes, badges }

/// Your profile, laid out like Fomo's: identity, a full-bleed score chart, cash
/// balance, then positions / takes / badges.
struct ProfileView: View {
    @Environment(AppState.self) private var app
    @State private var showSettings = false
    @Environment(SessionStore.self) private var session
    @State private var range = "1W"
    @State private var scrub: Int?
    @State private var tab: ProfileTab = .positions
    @State private var editing = false
    @State private var sharing: CallCard?
    /// A draft you tapped: the new-take flow opens on it.
    @State private var resuming: TakeDraft?

    private var drafts: [TakeDraft] { DraftStore.shared.drafts(for: app.me.id) }

    /// Takes are real. Positions come from your trades, or from the chain on the fork; badges
    /// come from the chain on the fork and later otherwise.
    private var items: [ProfileItem] {
        guard app.isLive else {
            switch tab {
            case .positions: return app.positions.map { ProfileItem(position: $0, me: app.me) }
            case .takes: return MockData.myTakes
            case .badges: return MockData.badges
            }
        }
        switch tab {
        case .takes: return app.myTakes.map(ProfileItem.init(liveTake:))
        case .positions:
            guard app.isOnFork else { return app.positions.map { ProfileItem(position: $0, me: app.me) } }
            return (app.forkPortfolio?.holdings ?? []).map { ProfileItem(forkPosition: $0, take: app.loadedTake($0.takeId), me: app.me) }
        case .badges: return (app.forkPortfolio?.badges ?? []).map(ProfileItem.init(forkBadge:))
        }
    }

    private var positionCount: Int { app.isOnFork ? app.forkPortfolio?.holdings.count ?? 0 : app.positions.count }

    private var emptyText: String {
        switch tab {
        case .positions: "Trade or fade a take and it shows up here."
        case .takes: "Takes you post show up here."
        case .badges: "Call it right and you'll earn a badge."
        }
    }

    /// On the fork the chart is your portfolio (cash plus positions) over the range you pick.
    private var ranges: [String] { app.isOnFork ? ["1D", "1W", "1M", "All"] : MockData.scoreRanges }

    /// Until there's a score history, live accounts chart start → now. On the fork: the portfolio.
    private var score: ScoreSeries {
        guard app.isLive else { return MockData.score(range) }
        if app.isOnFork {
            let h = app.portfolioHistory[range]
            var points = h?.points ?? []
            if points.count < 2 {
                let v = points.first?.value ?? h?.value ?? app.balance
                points = [.init(at: Date.now.timeIntervalSince1970, value: v), .init(at: Date.now.timeIntervalSince1970, value: v)]
            }
            let time = Date.FormatStyle(date: range == "1D" ? .omitted : .abbreviated, time: range == "1D" ? .shortened : .omitted)
            return ScoreSeries(points: points.map(\.value),
                               labels: points.map { Date(timeIntervalSince1970: $0.at).formatted(time) },
                               pct: h?.changePct ?? 0, caption: Self.caption[range] ?? "", rank: "")
        }
        return ScoreSeries(points: [0, app.me.made], labels: ["Start", "Now"], pct: app.me.returnPct,
                           caption: "all time", rank: "")
    }

    private static let caption = ["1D": "today", "1W": "past week", "1M": "past month", "All": "all time"]

    var body: some View {
        let me = app.me
        let score = score
        let last = score.points.count - 1
        let idx = min(max(scrub ?? last, 0), last)
        // The fork shows your portfolio's value (and its move since the range began); otherwise your score.
        let portfolio = app.isOnFork
        let parts = Fmt.splitCents(score.points[idx], signed: !portfolio)
        let change = score.points[idx] - score.points[0]
        let changePct = score.points[0] > 0 ? change / score.points[0] * 100 : 0

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .bottom) {
                            Avatar(name: me.avatar, size: 72)
                            Spacer()
                            Button("Edit profile") { editing = true }
                                .font(.geist(14, .semibold))
                                .buttonStyle(.glass)
                        }
                        Text(me.name).font(.geist(24, .bold)).padding(.top, 4)
                        Text(me.handle)
                            .font(.geist(14)).foregroundStyle(Palette.muted).padding(.top, -6)
                        if !me.bio.isEmpty {
                            Text(me.bio).font(.geist(14))
                        }
                        HStack(spacing: 16) {
                            NavigationLink(value: PeopleRoute.connections(.following)) {
                                HStack(spacing: 4) { Text("\(app.followingCount)").fontWeight(.semibold); Text("Following").foregroundStyle(Palette.muted) }
                            }
                            NavigationLink(value: PeopleRoute.connections(.followers)) {
                                HStack(spacing: 4) { Text("\(app.followerCount)").fontWeight(.semibold); Text("Followers").foregroundStyle(Palette.muted) }
                            }
                            Spacer()
                            NavigationLink(value: PeopleRoute.saved) {
                                Label("Saved", systemImage: "bookmark").foregroundStyle(Palette.muted)
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.geist(14))
                        HStack(spacing: 14) {
                            if app.isLive {
                                Text("\(app.myTakes.count) \(app.myTakes.count == 1 ? "TAKE" : "TAKES")"); Text("\(positionCount) \(positionCount == 1 ? "POSITION" : "POSITIONS")")
                            } else {
                                Text("6 TAKES"); Text("33 POSITIONS"); Text("JOINED OCT 2026")
                            }
                        }
                        .font(.mono(11))
                        .foregroundStyle(Palette.muted)
                        if app.isOnFork {
                            // The second score, next to your own P&L below.
                            HStack(spacing: 6) {
                                Text(Fmt.usd(me.backersMade, cents: true, signed: true))
                                    .foregroundStyle(me.backersMade < 0 ? Palette.down : Palette.up)
                                Text("MADE FOR BACKERS · \(Fmt.pct(me.backersPct))").foregroundStyle(Palette.muted)
                            }
                            .font(.mono(11))
                        }

                    }
                    .padding(.horizontal, 18)

                    Hairline().padding(.top, 16)

                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 0) {
                                Text(parts.whole)
                                Text(parts.cents).foregroundStyle(Palette.muted)
                            }
                            .font(.geist(36, .bold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            HStack(spacing: 6) {
                                if portfolio {
                                    Text("\(Fmt.usd(change, cents: true, signed: true)) (\(Fmt.pct(changePct, digits: 2)))")
                                        .foregroundStyle(change < 0 ? Palette.down : Palette.up)
                                } else {
                                    // The return scales with the point scrubbed to; a loss reads red.
                                    let pct = score.points[last] == 0 ? 0 : score.pct * score.points[idx] / score.points[last]
                                    Text(Fmt.pct(pct))
                                        .foregroundStyle(Palette.sign(pct: pct))
                                }
                                Text(scrub == nil ? score.caption : score.labels[idx]).foregroundStyle(Palette.muted)
                            }
                            .font(.mono(12))
                        }
                        Spacer()
                        if !app.isLive || portfolio {
                            RangePicker(options: ranges, selection: $range)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 14)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(portfolio
                        ? "Portfolio \(parts.whole)\(parts.cents), \(Fmt.usd(change, cents: true, signed: true)) \(score.caption)"
                        : "Thesis Score \(parts.whole)\(parts.cents), \(score.caption)")

                    PerformanceChart(values: score.points, height: 120, selection: $scrub)
                        .padding(.top, 10)
                        .padding(.horizontal, 4)

                    HStack(spacing: 8) {
                        Button { app.openCash() } label: {
                            HStack(spacing: 6) {
                                Text("Cash balance").font(.geist(15))
                                Text(Fmt.usd(app.balance, cents: true)).font(.mono(15, .semibold))
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Palette.muted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Cash balance \(Fmt.usd(app.balance, cents: true)). Activity")
                        Spacer(minLength: 4)
                        if !app.isOnFork {
                            Button("Withdraw") { app.startWithdraw() }
                                .font(.geist(13, .semibold))
                                .buttonStyle(.glass)
                                .disabled(app.balance <= 0)
                        }
                        Button("Add cash") { app.addCash() }
                            .font(.geist(13, .semibold))
                            .buttonStyle(.glass)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    Hairline().padding(.horizontal, 18)

                    // Your creator fees: only here, on your own profile, once something's been earned.
                    if app.isOnFork, let fees = app.creatorFees, fees.earnedUsd > 0 {
                        CreatorFeesSection(fees: fees)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 14)
                        Hairline().padding(.horizontal, 18)
                    }

                    // Drafts sit above the tabs, so they're there whichever tab you're on.
                    if !drafts.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(drafts.count == 1 ? "1 draft" : "\(drafts.count) drafts")
                                .font(.mono(12))
                                .foregroundStyle(Palette.muted)
                                .textCase(.uppercase)
                                .padding(.top, 12)
                            ForEach(drafts) { draft in
                                Button { resuming = draft } label: { DraftRow(draft: draft) }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        Button("Delete draft", systemImage: "trash", role: .destructive) {
                                            withAnimation(.snappy) { DraftStore.shared.remove(draft.id) }
                                        }
                                    }
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.bottom, 4)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("profile-drafts")
                        Hairline().padding(.horizontal, 18)
                    }

                    UnderlineTabs(items: [(ProfileTab.positions, "Open positions"), (.takes, "My takes"), (.badges, "Badges")],
                                  selection: $tab)
                        .padding(.horizontal, 18)
                        .padding(.top, 4)

                    VStack(spacing: 0) {
                        ForEach(items) { item in
                            if let take = item.take, take.posting {
                                VStack(spacing: 0) {
                                    ProfileItemRow(item: item)
                                    PostingBar(take: take).padding(.leading, 56)
                                }
                            } else if let take = item.take {
                                HStack(spacing: 4) {
                                    NavigationLink(value: take) { ProfileItemRow(item: item) }
                                        .buttonStyle(.plain)
                                    if tab == .positions, let card = item.share { shareButton(card) }
                                }
                            } else if tab == .positions, let card = item.share {
                                HStack(spacing: 4) {
                                    ProfileItemRow(item: item)
                                    shareButton(card)
                                }
                            } else {
                                ProfileItemRow(item: item)
                            }
                        }
                        if items.isEmpty {
                            Text(emptyText)
                                .font(.geist(14))
                                .foregroundStyle(Palette.muted)
                                .frame(maxWidth: .infinity, minHeight: 80)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 24)

                    Hairline().padding(.horizontal, 18)
                    LogOutRow(horizontalPadding: 18)
                        .padding(.bottom, 24)
                }
            }
            .background(ThesisBackground())
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .peopleDestinations()
            .onChange(of: range) { scrub = nil }
            .refreshable {
                await app.refresh()
                await app.refreshPortfolio()
            }
            .task { await app.refreshPortfolio() }
            .task(id: range) { await app.refreshHistory(range) }
            .sheet(isPresented: $editing) { EditProfileView() }
            .sheet(item: $sharing) { CalledItShareSheet(card: $0) }
            .fullScreenCover(item: $resuming) { CreateFlow(draft: $0) }
            .navigationDestination(isPresented: $showSettings) { SettingsView() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: AppConfig.profileURL(me.id), message: Text("My takes on Thesis")) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share profile")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Settings", systemImage: "gearshape") { showSettings = true }
                        Divider()
                        Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            session.logOutRequested = true
                        }
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            }
    }
}

extension ProfileView {
    /// Share one of your positions as a called-it card.
    fileprivate func shareButton(_ card: CallCard) -> some View {
        Button { sharing = card } label: {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(card.called ? Palette.up : Palette.muted)
                .frame(width: 40, height: 40)
                .background(card.called ? Palette.up.opacity(0.14) : Palette.tile, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(card.called ? "Share: called it" : "Share position")
        .accessibilityIdentifier("position.share")
    }
}

private extension ProfileItem {
    /// One of your positions on the fork: what your wallet holds now against what it paid.
    init(forkPosition p: ForkPortfolio.Position, take: Take?, me: Person) {
        let pnl = p.valueUsd.flatMap { value in p.costUsd.map { cost in cost > 0 ? (value / cost - 1) * 100 : 0 } }
        let score = p.returnBps.map { "score \(Fmt.pct(Double($0) / 100))" }
        let detail = p.pendingNote ?? score ?? "pricing…"
        self.init(topic: p.topic ?? "topic-coin", claim: p.claim,
                  kind: p.side == "fade" ? "Faded" : "Traded", kindColor: p.side == "fade" ? Palette.down : Palette.up,
                  meta: [p.authorHandle.map { "@\($0)" }, detail].compactMap { $0 }.joined(separator: " · "),
                  value: Fmt.usd(p.valueUsd ?? p.stakeUsd, cents: true), ret: pnl ?? 0, take: take, showsReturn: pnl != nil,
                  share: pnl.map { CallCard(takeID: p.takeId, claim: p.claim, ret: $0, faded: p.side == "fade",
                                            author: p.authorHandle, name: me.name, handle: me.id, avatar: me.avatar,
                                            since: take?.since, legs: take?.legs ?? []) })
    }

    /// A "called it" badge your wallet holds (a non-transferable Token-2022 token).
    init(forkBadge b: ForkPortfolio.Badge) {
        self.init(topic: "topic-coin", claim: b.title, kind: "Badge", kindColor: Palette.up,
                  meta: "on-chain · \(b.mint.prefix(4))…\(b.mint.suffix(4))", value: "", ret: 0, showsReturn: false,
                  imageURL: b.image.flatMap(URL.init(string:)))
    }

    /// A take you hold: what it's worth now, and your return on it.
    init(position p: OwnedPosition, me: Person) {
        self.init(topic: p.take.topic, claim: p.take.claim,
                  kind: p.side == .back ? "Traded" : "Faded",
                  kindColor: p.side == .back ? Palette.up : Palette.down,
                  meta: p.take.author.handle(then: "\(Fmt.usd(p.amount, cents: true)) in"),
                  value: Fmt.usd(p.value, cents: true), ret: p.ret, take: p.take,
                  share: CallCard(takeID: p.take.id, claim: p.take.claim, ret: p.ret, faded: p.side == .fade,
                                  author: p.take.author.handleID, name: me.name, handle: me.id, avatar: me.avatar,
                                  since: p.take.since, legs: p.take.legs))
    }

    /// One of your takes as a profile row (still posting: only you see it).
    init(liveTake take: Take) {
        if take.posting {
            self.init(topic: take.topic, claim: take.claim, kind: "Posting", kindColor: Palette.muted,
                      meta: "only you can see it", value: "", ret: 0, take: take, showsReturn: false)
        } else if take.isOpen {
            self.init(topic: take.topic, claim: take.claim, kind: "Open", kindColor: Palette.text,
                      meta: "until you sell · \(take.backs) traded",
                      value: Fmt.usd(take.moneyIn), ret: take.ret, take: take)
        } else {
            // You sold your buy-in (or it ran its year): its result is final.
            let day = take.closedOn.map { " " + $0.formatted(.dateTime.month(.abbreviated).day()) } ?? ""
            self.init(topic: take.topic, claim: take.claim, kind: "Closed", kindColor: Palette.muted,
                      meta: "closed\(day) · \(take.backs) traded",
                      value: Fmt.usd(take.moneyIn), ret: take.ret, take: take)
        }
    }
}

/// A take you closed without posting: tap to pick it up again.
private struct DraftRow: View {
    let draft: TakeDraft

    private var meta: String {
        let saved = draft.savedAt.map { "saved \($0.formatted(.relative(presentation: .named)))" } ?? "saved"
        return draft.isBuilt ? "\(saved) · basket ready" : saved
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.muted)
                .frame(width: 44, height: 44)
                .background(Palette.tile, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(draft.claim).font(.serif(17)).lineLimit(1)
                HStack(spacing: 4) {
                    Text("Draft").fontWeight(.semibold).foregroundStyle(Palette.text)
                    Text("· \(meta)").foregroundStyle(Palette.muted)
                }
                .font(.geist(12))
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.muted)
        }
        .frame(minHeight: 62)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Draft: \(draft.claim). \(meta)")
        .accessibilityIdentifier("draft-row")
    }
}

private struct ProfileItemRow: View {
    let item: ProfileItem

    var body: some View {
        HStack(spacing: 12) {
            if let url = item.imageURL {
                // A badge's art; the topic tile until it loads, or if it can't.
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    TopicTile(image: item.topic, size: 44, circle: true)
                }
                .frame(width: 44, height: 44)
                .clipShape(Circle())
                .accessibilityHidden(true)
            } else {
                TopicTile(image: item.topic, size: 44, circle: true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.claim)
                    .font(.serif(17))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(item.kind).fontWeight(.semibold).foregroundStyle(item.kindColor)
                    Text("· \(item.meta)").foregroundStyle(Palette.muted)
                }
                .font(.geist(12))
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(item.value).font(.mono(14, .semibold))
                if item.showsReturn {
                    Text(Fmt.pct(item.ret)).font(.mono(12)).foregroundStyle(Palette.sign(pct: item.ret))
                }
            }
        }
        .frame(minHeight: 62)
        .accessibilityElement(children: .combine)
    }
}
