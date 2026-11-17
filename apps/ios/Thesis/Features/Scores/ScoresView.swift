import SwiftUI

private enum Metric: Hashable { case cash, pct }

/// Leaderboards, each ranked by dollars or by percent: your own P&L, what your takes made for
/// the people who backed them, and what you made fading other people's takes (the last two on
/// fork builds only: they come from the chain).
struct ScoresView: View {
    @Environment(AppState.self) private var app
    @State private var period = "Week"
    @State private var metric: Metric = .cash
    @State private var scoreBoard: ScoreBoard = .own
    @State private var board: [LeaderRow] = []
    @State private var loading = true

    private var periodCaption: String { period == "All time" ? "all time" : "this \(period.lowercased())" }

    /// Your line: from the board when signed in (rank "—" if you're not on it).
    private func myLine(sorted: [LeaderRow]) -> (rank: String, cash: Double, pct: Double, takes: Int) {
        guard app.isLive else {
            let me = MockData.leaderboard(period).me
            return ("#\(metric == .cash ? me.cashRank : me.pctRank)", me.cash, me.pct, MockData.me.takes)
        }
        if let i = sorted.firstIndex(where: { app.isMe($0.person) }) {
            let row = sorted[i]
            return ("#\(i + 1)", row.cash, row.pct, row.takes)
        }
        if scoreBoard == .backers { return ("—", app.me.backersMade, app.me.backersPct, app.myTakes.count) }
        return ("—", 0, 0, app.myTakes.count)
    }

    var body: some View {
        let byCash = metric == .cash
        let sorted = board.sorted { byCash ? $0.cash > $1.cash : $0.pct > $1.pct }
        // You're pinned at the top as "You" with your rank, so the list leaves your own row out
        // (each row keeps its rank on the full board).
        let rows = Array(sorted.enumerated()).filter { !app.isMe($0.element.person) }.prefix(app.isLive ? 25 : 5)
        let mine = myLine(sorted: sorted)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Picker("Period", selection: $period) {
                        ForEach(MockData.periods, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 4)

                    HStack {
                        if app.isOnFork {
                            // Three boards; the dollars / percent switch moves to the right.
                            UnderlineTabs(items: [(ScoreBoard.own, "Own P&L"), (.backers, "For backers"), (.faders, "Faders")],
                                          selection: $scoreBoard, spacing: 16)
                            Spacer()
                            Button {
                                metric = byCash ? .pct : .cash
                            } label: {
                                Label(byCash ? "BY $" : "BY %", systemImage: "arrow.up.arrow.down")
                                    .font(.mono(11, .semibold))
                                    .foregroundStyle(Palette.text)
                                    .padding(.horizontal, 10)
                                    .frame(minHeight: 30)
                                    .background(Palette.tile, in: .capsule)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(byCash ? "Ranked by dollars" : "Ranked by percent")
                            .accessibilityHint(byCash ? "Ranks by percent instead" : "Ranks by dollars instead")
                        } else {
                            UnderlineTabs(items: [(Metric.cash, "Cash made"), (.pct, "Return %")], selection: $metric)
                            Spacer()
                            Text(byCash ? "CASH · RETURN" : "RETURN · CASH")
                                .font(.mono(11))
                                .foregroundStyle(Palette.muted)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    Hairline()

                    LeaderRowView(
                        rank: mine.rank,
                        rankColor: Palette.muted,
                        person: app.me, title: "You",
                        subtitle: "\(mine.takes) \(mine.takes == 1 ? "take" : "takes") · \(periodCaption)",
                        primary: byCash ? Fmt.usd(mine.cash, cents: true, signed: true) : Fmt.pct(mine.pct),
                        secondary: byCash ? Fmt.pct(mine.pct) : Fmt.usd(mine.cash, cents: true, signed: true)
                    )
                    .background(Palette.upSoft)
                    Hairline()

                    ForEach(rows, id: \.element.id) { index, row in
                        LeaderRowView(
                            rank: "\(index + 1)",
                            rankColor: index == 0 ? Palette.gold : Palette.muted,
                            person: row.person, title: row.person.handle,
                            subtitle: "\(row.takes) \(row.takes == 1 ? "take" : "takes")",
                            primary: byCash ? Fmt.usd(row.cash, signed: true) : Fmt.pct(row.pct),
                            secondary: byCash ? Fmt.pct(row.pct) : Fmt.usd(row.cash, signed: true)
                        )
                        Hairline()
                    }

                    if loading && board.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                    }

                    if !loading && board.isEmpty {
                        Text(emptyText)
                            .font(.geist(14))
                            .foregroundStyle(Palette.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 30)
                    }

                    Text(caption)
                        .font(.geist(12))
                        .foregroundStyle(Palette.muted)
                        .padding(16)
                }
                .padding(.bottom, 24)
            }
            .background(ThesisBackground())
            .navigationTitle("Scores")
            .task(id: LoadKey(period: period, board: scoreBoard, metric: metric)) { await load() }
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .peopleDestinations()
            .refreshable { await load() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ProfileMenuButton()
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
    }
}

private struct LoadKey: Hashable {
    let period: String
    let board: ScoreBoard
    let metric: Metric
}

extension ScoresView {
    private var caption: String {
        guard app.isOnFork else { return "Return % only ranks accounts with $100+ in, so tiny bets can't top the board." }
        return switch scoreBoard {
        case .own: "Own P&L: what each account made on its own positions that have settled or been sold."
        case .backers: "Made for backers: what everyone who backed an account's takes made, losses subtracted. Fades and the author's own money don't count."
        case .faders: "Faders: what each account made fading other people's takes, on fades that have settled or been sold."
        }
    }

    private var emptyText: String {
        switch scoreBoard {
        case .own: "Nobody is on the board yet."
        case .backers: "Nobody has posted a take yet."
        case .faders: "Nobody has faded a take yet."
        }
    }

    private func load() async {
        loading = true
        do {
            board = try await app.leaderboard(period, board: scoreBoard, byPct: metric == .pct)
        } catch {
            app.actionError = (error as? LocalizedError)?.errorDescription ?? "Couldn't load Scores."
        }
        loading = false
    }
}

private struct LeaderRowView: View {
    let rank: String
    let rankColor: Color
    let person: Person
    let title: String
    let subtitle: String
    let primary: String
    let secondary: String

    var body: some View {
        PersonLink(person: person) { row }
    }

    private var row: some View {
        HStack(spacing: 12) {
            Text(rank).font(.mono(13, .semibold)).foregroundStyle(rankColor).frame(width: 30, alignment: .leading)
            Avatar(name: person.avatar, size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.geist(15, .semibold))
                Text(subtitle).font(.geist(12)).foregroundStyle(Palette.muted)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(primary).font(.mono(15, .semibold)).foregroundStyle(primary.hasPrefix("-") || primary.hasPrefix("−") ? Palette.down : Palette.up)
                Text(secondary).font(.mono(12)).foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 68)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
