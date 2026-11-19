import SwiftUI

/// The take page: sectionless, hairlines between sections, glass only on the
/// floating Trade / Fade bar and the toolbar.
struct TakeDetailView: View {
    @Environment(AppState.self) private var app
    let take: Take

    @State private var range = "All"
    @State private var scrub: Int?
    @State private var trade: TradeIntent?
    @State private var showComments = false
    @State private var topComments: [Comment] = []
    @State private var traders: [Trader] = []
    @State private var showTraders = false
    /// Fork mode: the take as the chain sees it.
    @State private var receipt: ForkReceipt?

    /// Real takes only have the since-posted history until prices are wired.
    private var ranges: [String] { app.isLive ? ["All"] : MockData.takeRanges }

    private var series: (values: [Double], labels: [String], caption: String) {
        MockData.series(for: take, range: range)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                performance.padding(.top, 22)
                if !held.isEmpty { section { yourPosition } }
                section { basket }
                if app.isOnFork {
                    section {
                        ForkReceiptView(receipt: receipt, takeID: take.id) { trade = TradeIntent(take: current, side: $0, tab: .sell) }
                    }
                }
                section { sentiment }
                section { commentsPreview }
                LockedNote(text: "LOCKED \(take.since.uppercased()) · CAN'T BE EDITED OR DELETED")
                    .padding(.top, 20)
                    .padding(.bottom, 24)
            }
        }
        .background(ThesisBackground())
        .navigationBarTitleDisplayMode(.inline)
        // The page has its own Fade / Trade bar: the tab bar would sit on top of it and of the
        // page's last section. (The new-take accessory stays, below the bar.)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { withAnimation(.snappy) { app.toggleSave(take) } } label: {
                    Image(systemName: app.isSaved(take) ? "bookmark.fill" : "bookmark")
                        .contentTransition(.symbolEffect(.replace))
                }
                .sensoryFeedback(.selection, trigger: app.isSaved(take))
                .accessibilityLabel(app.isSaved(take) ? "Remove from saved" : "Save")
                ShareCardButton(take: take, takeReturn: chainReturnPct) {
                    Image(systemName: "square.and.arrow.up")
                }
            }
        }
        .safeAreaBar(edge: .bottom) {
            Group {
                if current.isOpen {
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            // You can't fade your own take.
                            if !app.isMe(take.author) {
                                SidePill(side: .fade, height: 54) { trade = TradeIntent(take: current, side: .fade) }
                                    .frame(width: 118)
                            }
                            SidePill(side: .back, title: "Trade this take", height: 54, expand: true) {
                                trade = TradeIntent(take: current, side: .back)
                            }
                        }
                    }
                } else {
                    // The author sold their buy-in (or it ran its year): no new trades or fades.
                    // Positions still held sell from the receipt.
                    Text(current.closedReason)
                        .font(.geist(15, .semibold))
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .glassEffect(.regular, in: .capsule)
                        .accessibilityIdentifier("take-closed")
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
        .sheet(item: $trade, onDismiss: {
            Task {
                traders = await app.traders(for: take)
                receipt = await app.receipt(for: take)
            }
        }) { TradeSheet(intent: $0) }
        .task {
            guard app.isOnFork else { return }
            receipt = await app.receipt(for: take)
            // Keep the receipt live while the page is open: the settler records a new position's
            // entry price a few seconds after the trade, and returns move with prices.
            while !Task.isCancelled {
                // Quickly right after a trade (the settler records its entry price within a tick);
                // otherwise every 15 s, also while a leg waits for the stock market to open.
                let fresh = receipt?.viewerPositions?.contains(where: \.isFresh) ?? false
                try? await Task.sleep(for: .seconds(fresh ? 3 : 15))
                guard !Task.isCancelled else { break }
                receipt = await app.receipt(for: take)
            }
        }
        .sheet(isPresented: $showTraders) { TradersView(take: take, traders: traders) }
        .task { traders = await app.traders(for: take) }
        .sheet(isPresented: $showComments, onDismiss: { Task { await loadComments() } }) {
            CommentsView(take: take)
        }
        .onChange(of: range) { scrub = nil }
        .task { await loadComments() }
    }

    private func loadComments() async {
        guard let all = try? await app.comments(on: take) else { return }
        topComments = Array(all.sorted { $0.likes > $1.likes }.prefix(2))
    }

    private func section<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline().padding(.bottom, 18)
            content()
        }
        .padding(.horizontal, 18)
        .padding(.top, 22)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                PersonLink(person: take.author) {
                    HStack(spacing: 10) {
                        Avatar(name: take.author.avatar, size: 44)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(take.author.name).font(.geist(15, .semibold))
                                if !take.author.deleted {
                                    Text(take.author.handle).font(.geist(15)).foregroundStyle(Palette.muted)
                                }
                            }
                            HStack(spacing: 4) {
                                Text("Made").foregroundStyle(Palette.muted)
                                Text(Fmt.usd(take.author.made, signed: true)).fontWeight(.semibold)
                                    .foregroundStyle(take.author.made >= 0 ? Palette.up : Palette.down)
                                Text("· \(String(format: "%.1f", take.author.returnPct))% return").foregroundStyle(Palette.muted)
                            }
                            .font(.geist(13))
                        }
                    }
                }
                Spacer()
                if !app.isMe(take.author) && !take.author.deleted {
                    let following = app.isFollowing(take.author)
                    Button(following ? "Following" : "Follow") {
                        withAnimation(.snappy) { app.toggleFollow(take.author) }
                    }
                    .font(.geist(14, .semibold))
                    .buttonStyle(.glass)
                    .sensoryFeedback(.selection, trigger: following)
                    .accessibilityLabel(following ? "Unfollow \(take.author.name)" : "Follow \(take.author.name)")
                }
            }

            HStack(alignment: .top, spacing: 14) {
                Text(take.claim)
                    .font(.serif(34))
                    .lineSpacing(-2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TopicTile(image: take.topic, size: 64, corner: 20)
            }

            VStack(alignment: .leading, spacing: 4) {
                // "Open · until @priya sells", or "Closed Nov 18 · +4.2%".
                Text(current.statusLine(result: chainReturnPct))
                    .font(.geist(14, .semibold))
                    .foregroundStyle(current.isOpen ? Palette.text : Palette.muted)
                    .accessibilityIdentifier("take-status")
                Text("\(take.risk.rawValue.uppercased()) RISK · \(take.comments) COMMENTS")
                    .font(.mono(11))
                    .foregroundStyle(Palette.muted)
            }

            if let source = take.source {
                Link(destination: source.url) {
                    HStack(spacing: 6) {
                        SourceMark(source: source)
                        Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.muted)
                    }
                }
                .accessibilityIdentifier("take-source")
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
    }

    // MARK: Performance

    private var performance: some View {
        let values = series.values
        let last = max(0, values.count - 1)
        let idx = min(max(scrub ?? last, 0), last)
        // On the fork the headline is the chain's: the author's position at live prices (or the
        // settled result). There's no price history yet, so scrubbing still reads the chart.
        let onChain = app.isOnFork && receipt?.onChain == true && scrub == nil
        let chain = onChain ? chainReturnPct : nil
        let change = chain ?? (values.isEmpty ? 0 : values[idx] - values[0])
        let caption = onChain ? (chain == nil ? "on-chain · waiting for entry prices" : "on-chain · since posted") : nil

        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(onChain && chain == nil ? "—" : Fmt.pct(change))
                        .font(.geist(40, .bold))
                        .monospacedDigit()
                        .foregroundStyle(onChain && chain == nil ? Palette.muted : Palette.sign(pct: change))
                        .contentTransition(.numericText())
                    Text(scrub == nil ? (caption ?? series.caption) : series.labels[idx])
                        .font(.mono(12))
                        .foregroundStyle(Palette.muted)
                }
                Spacer()
                if ranges.count > 1 {
                    RangePicker(options: ranges, selection: $range)
                }
            }
            .padding(.horizontal, 18)

            PerformanceChart(values: values, color: Palette.sign(pct: take.ret),
                             showEntryLine: range == "All", height: 160, selection: $scrub)
                .padding(.horizontal, 4)
        }
    }

    /// The take with its status from the on-chain receipt once it's loaded (fork mode): open,
    /// or closed since its author sold.
    private var current: Take { take.updated(with: app.isOnFork ? receipt : nil) }

    /// The take's return from its on-chain receipt (fork mode), once the author's prices are in.
    private var chainReturnPct: Double? {
        guard app.isOnFork, let r = receipt, r.onChain, let bps = r.returnBps else { return nil }
        return Double(bps) / 100
    }

    /// A leg's return: on the fork, the author's entry against the live price (nil until both are
    /// in, or for legs the author didn't buy); otherwise the backend's number.
    private func legReturnPct(_ leg: Leg) -> Double? {
        guard app.isOnFork else { return leg.ret }
        guard let l = receipt?.legs.first(where: { $0.name == leg.name }),
              let entry = l.authorEntryUsd, let now = l.currentUsd, entry > 0 else { return nil }
        return (now / entry - 1) * 100
    }

    // MARK: Basket

    private var basket: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Basket").font(.geist(17, .semibold))
                Spacer()
                Text("WEIGHT · RETURN").font(.mono(11)).foregroundStyle(Palette.muted)
            }
            HStack(spacing: 18) {
                BasketDonut(legs: take.legs, innerRatio: 0.68)
                    .frame(width: 116, height: 116)
                VStack(spacing: 11) {
                    ForEach(take.legs) { leg in
                        let row = HStack(spacing: 8) {
                            AssetLogo(key: leg.assetKey, name: leg.name, kind: leg.kind, size: 22, ring: Palette.series(leg.slot))
                            Text(leg.name).font(.geist(14)).lineLimit(1)
                            Spacer(minLength: 4)
                            Text("\(Int(leg.weight))%").font(.mono(12)).foregroundStyle(Palette.muted)
                                .frame(width: 34, alignment: .trailing)
                            let ret = legReturnPct(leg)
                            Text(ret.map { Fmt.pct($0) } ?? "—").font(.mono(12, .semibold))
                                .foregroundStyle(ret.map { Palette.sign(pct: $0) } ?? Palette.muted)
                                .frame(width: 58, alignment: .trailing)
                        }
                        // A pick from the catalog opens its asset page.
                        if let id = leg.assetID {
                            NavigationLink(value: PeopleRoute.asset(id)) { row.contentShape(Rectangle()) }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens \(leg.name)")
                        } else {
                            row
                        }
                    }
                }
            }
        }
    }

    // MARK: Your position

    /// Your trade and/or fade on this take, on mock data. Signed in, positions are on-chain
    /// (the receipt's "Sell position"), so these don't apply. Sell opens the trade sheet's Sell tab.
    private var held: [OwnedPosition] {
        guard !app.isOnFork else { return [] }
        return [Side.back, .fade].compactMap { app.position(in: take, side: $0) }
    }

    private var yourPosition: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Your position").font(.geist(17, .semibold))
            ForEach(held) { p in
                VStack(alignment: .leading, spacing: 12) {
                    Label(p.side == .back ? "Traded" : "Faded", systemImage: p.side.arrow)
                        .font(.geist(13, .semibold))
                        .foregroundStyle(p.side.text)
                    PositionFigures(position: p)
                    Button { trade = TradeIntent(take: current, side: p.side, tab: .sell) } label: {
                        Text("Sell").font(.geist(15, .semibold)).frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .accessibilityLabel(p.side == .back ? "Sell your trade" : "Sell your fade")
                    .accessibilityIdentifier("sell-\(p.side.serverValue)")
                }
            }
        }
    }

    // MARK: Sentiment

    /// The take with its counts from the on-chain receipt once it's loaded (fork mode): the copy
    /// this page opened with is the feed's, and goes stale as soon as someone trades or fades.
    private var counted: Take {
        guard app.isOnFork, let r = receipt, r.onChain, let backers = r.backers else { return take }
        var t = take
        t.backs = backers
        t.fades = r.faders ?? 0
        t.moneyIn = (r.totalBackedUsd ?? 0) + (r.totalFadedUsd ?? 0)
        return t
    }

    /// "You, Priya and 22 others traded · 7 faded · $1,240 in", with their faces.
    /// Opens the Traders sheet.
    private var tradersLine: some View {
        let traded = traders.filter { $0.side == .back }
        let named = Array(traded.prefix(2))
        let names = named.map { $0.isYou ? "You" : $0.person.name }
        let others = max(0, counted.backs - named.count)
        let who: String = {
            switch (names.count, others) {
            case (0, _): return "\(counted.backs)"
            case (1, 0): return names[0]
            case (2, 0): return "\(names[0]) and \(names[1])"
            default: return names.joined(separator: ", ") + " and \(others) \(others == 1 ? "other" : "others")"
            }
        }()
        let faces = Array((traded + traders.filter { $0.side == .fade }).prefix(3))
        return Button { showTraders = true } label: {
            HStack(spacing: 8) {
                if !faces.isEmpty {
                    HStack(spacing: -7) {
                        ForEach(faces) { t in
                            Avatar(name: t.person.avatar, size: 24)
                                .overlay(Circle().stroke(Palette.bg, lineWidth: 2))
                        }
                    }
                }
                Text("\(who) traded · \(counted.fades) faded · \(Fmt.usd(counted.moneyIn)) in")
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows who traded and faded")
        .accessibilityIdentifier("traders-line")
    }

    private var sentiment: some View {
        let share = counted.backingShare
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(Int((share * 100).rounded()))% trading").foregroundStyle(Palette.up)
                Spacer()
                Text("\(Int(((1 - share) * 100).rounded()))% fading").foregroundStyle(Palette.down)
            }
            .font(.geist(14, .semibold))

            GeometryReader { geo in
                HStack(spacing: 3) {
                    Capsule().fill(Palette.backFill).frame(width: (geo.size.width - 3) * share)
                    Capsule().fill(Palette.fadeFill)
                }
            }
            .frame(height: 6)

            tradersLine
        }
    }

    // MARK: Comments

    private var commentsPreview: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                HStack(spacing: 6) {
                    Text("Comments").font(.geist(17, .semibold))
                    Text("\(take.comments)").font(.geist(17, .medium)).foregroundStyle(Palette.muted)
                }
                Spacer()
                Button("See all") { showComments = true }
                    .font(.geist(14, .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(minHeight: 44)
            }
            ForEach(topComments) { c in
                CommentRow(comment: c, compact: true)
                    .padding(.vertical, 10)
            }
            Button { showComments = true } label: {
                HStack(spacing: 10) {
                    Avatar(name: app.me.avatar, size: 26)
                    Text("Add a comment…").font(.geist(14)).foregroundStyle(Palette.muted)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 46)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .padding(.top, 4)
        }
    }
}
