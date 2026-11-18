import SwiftUI

enum SearchScope: String, CaseIterable, Identifiable {
    /// Everything at once: assets, people and takes for whatever you type.
    case all = "All", takes = "Takes", people = "People", assets = "Assets"
    var id: String { rawValue }
}

struct SearchView: View {
    @Environment(AppState.self) private var app
    @State private var query = ""
    @State private var scope: SearchScope = .all
    @State private var topic = "All"
    @State private var results: [Take] = []
    @State private var people: [Person] = []
    @State private var assets: [Asset] = []
    @State private var topCallers: [Person] = []
    @State private var searching = false

    /// What the results are for; changing any reloads (debounced while typing).
    private struct Request: Equatable { let query: String; let topic: String; let scope: SearchScope }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Picker("Search for", selection: $scope) {
                        ForEach(SearchScope.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .accessibilityIdentifier("search-scope")

                    switch scope {
                    case .all: allResults
                    case .takes: takesResults
                    case .people: peopleResults
                    case .assets: assetResults
                    }
                }
                .padding(.top, 6)
                .padding(.bottom, 24)
            }
            .background(ThesisBackground())
            .navigationTitle("Search")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: scope == .assets ? "Ticker, company or idea" : scope == .people ? "Name or @handle" : "Anything: a ticker, an idea, a person")
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .task(id: Request(query: query, topic: topic, scope: scope)) { await load(debounce: !query.isEmpty) }
            .task { await loadTopCallers() }
            .peopleDestinations()
        }
    }

    // MARK: Takes

    @ViewBuilder private var takesResults: some View {
                    ScrollView(.horizontal, showsIndicators: false) {
                        GlassEffectContainer(spacing: 8) {
                            HStack(spacing: 8) {
                                ForEach(MockData.topics, id: \.self) { t in
                                    GlassChip(title: t, selected: topic == t) {
                                        withAnimation(.snappy) { topic = t }
                                    }
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 4)
                        }
                    }

                    if query.isEmpty {
                        SuggestedFollowsRow().padding(.top, 22)
                        Text("Top calls this week")
                            .font(.geist(13, .semibold))
                            .foregroundStyle(Palette.muted)
                            .padding(.horizontal, 16)
                            .padding(.top, 22)
                            .padding(.bottom, 12)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(topCallers) { person in
                                    PersonLink(person: person) {
                                    VStack(spacing: 5) {
                                        Avatar(name: person.avatar, size: 56)
                                            .padding(3.5)
                                            .overlay(Circle().strokeBorder(Palette.up, lineWidth: 1.5))
                                        Text(person.id).font(.geist(12, .medium))
                                        Text(Fmt.compact(person.made)).font(.mono(11)).foregroundStyle(Palette.up)
                                    }
                                    .frame(width: 68)
                                    .accessibilityElement(children: .combine)
                                    }
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                    }

                    Text(query.isEmpty ? (topic == "All" ? "Trending takes" : "Trending \(topic.lowercased()) takes") : "Results")
                        .font(.geist(13, .semibold))
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 16)
                        .padding(.top, 22)
                        .padding(.bottom, 4)

                    ForEach(results) { take in
                        NavigationLink(value: take) {
                            TakeListRow(take: take)
                        }
                        .buttonStyle(.plain)
                        Hairline()
                    }

                    if results.isEmpty {
                        if searching {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                        } else if query.isEmpty {
                            ContentUnavailableView("Nothing here yet", systemImage: "magnifyingglass",
                                                   description: Text("No \(topic == "All" ? "" : topic + " ")takes so far."))
                                .padding(.top, 40)
                        } else {
                            ContentUnavailableView.search(text: query)
                                .padding(.top, 40)
                        }
                    }
    }

    // MARK: All

    /// Nothing typed: the takes page (topics, top callers, trending). Typing: the best few of each
    /// kind, assets first, so a search always shows something.
    @ViewBuilder private var allResults: some View {
        if query.isEmpty {
            XTradersRow().padding(.bottom, 14)
            takesResults
        } else {
            if !assets.isEmpty {
                sectionHeader("Assets", more: assets.count > 4 ? .assets : nil)
                ForEach(assets.prefix(4)) { asset in
                    NavigationLink(value: PeopleRoute.asset(asset.id)) { AssetRow(asset: asset) }
                        .buttonStyle(.plain)
                    Hairline()
                }
            }
            if !people.isEmpty {
                sectionHeader("People", more: people.count > 3 ? .people : nil)
                ForEach(people.prefix(3)) { person in
                    PersonRow(person: person).padding(.horizontal, 16).padding(.vertical, 8)
                    Hairline()
                }
            }
            if !results.isEmpty {
                sectionHeader("Takes", more: results.count > 5 ? .takes : nil)
                ForEach(results.prefix(5)) { take in
                    NavigationLink(value: take) { TakeListRow(take: take) }
                        .buttonStyle(.plain)
                    Hairline()
                }
            }
            if assets.isEmpty && people.isEmpty && results.isEmpty {
                if searching {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else {
                    ContentUnavailableView.search(text: query).padding(.top, 40)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, more: SearchScope?) -> some View {
        HStack {
            Text(title).font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
            Spacer()
            if let more {
                Button("See all") { withAnimation(.snappy) { scope = more } }
                    .font(.geist(13, .semibold))
                    .foregroundStyle(Palette.up)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 4)
    }

    // MARK: People

    @ViewBuilder private var peopleResults: some View {
        if query.isEmpty {
            SuggestedFollowsRow().padding(.top, 12)
            Text("Search by name or @handle.")
                .font(.geist(13)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 16).padding(.top, 22)
        } else if people.isEmpty {
            if searching {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
            } else {
                ContentUnavailableView.search(text: query).padding(.top, 40)
            }
        } else {
            ForEach(people) { person in
                PersonRow(person: person).padding(.horizontal, 16).padding(.vertical, 8)
                Hairline()
            }
        }
    }

    // MARK: Assets

    @ViewBuilder private var assetResults: some View {
        Text(query.isEmpty ? "Most traded" : "Assets")
            .font(.geist(13, .semibold))
            .foregroundStyle(Palette.muted)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 4)
        if assets.isEmpty {
            if searching {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
            } else {
                ContentUnavailableView.search(text: query).padding(.top, 40)
            }
        }
        ForEach(assets) { asset in
            NavigationLink(value: PeopleRoute.asset(asset.id)) { AssetRow(asset: asset) }
                .buttonStyle(.plain)
            Hairline()
        }
    }

    private func load(debounce: Bool) async {
        if debounce {
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
        }
        searching = true
        defer { searching = false }
        do {
            switch scope {
            case .all:
                // All three at once; one failing (or slow) doesn't hold up the others.
                guard !query.isEmpty else {
                    let found = try await app.search(query, tag: topic == "All" ? nil : topic)
                    guard !Task.isCancelled else { return }
                    results = found
                    return
                }
                async let a = try? app.searchAssets(query)
                async let p = try? app.searchPeople(query)
                async let t = try? app.search(query, tag: nil)
                let (foundAssets, foundPeople, foundTakes) = await (a, p, t)
                guard !Task.isCancelled else { return }
                assets = foundAssets ?? []
                people = foundPeople ?? []
                results = foundTakes ?? []
            case .takes:
                let found = try await app.search(query, tag: topic == "All" ? nil : topic)
                guard !Task.isCancelled else { return }
                results = found
            case .people:
                let found = try await app.searchPeople(query)
                guard !Task.isCancelled else { return }
                people = found
            case .assets:
                let found = try await app.searchAssets(query)
                guard !Task.isCancelled else { return }
                assets = found
            }
        } catch {
            guard !Task.isCancelled else { return }
            app.actionError = (error as? LocalizedError)?.errorDescription ?? "Search didn't go through."
        }
    }

    private func loadTopCallers() async {
        guard app.isLive else {
            topCallers = MockData.topCallers
            return
        }
        if let rows = try? await app.leaderboard("Week") {
            topCallers = rows.prefix(6).map(\.person).filter { !app.isMe($0) }
        }
    }
}

/// Compact take row with topic image, used by Search and Saved.
struct TakeListRow: View {
    let take: Take

    var body: some View {
        HStack(spacing: 12) {
            TopicTile(image: take.topic, size: 50)
            VStack(alignment: .leading, spacing: 4) {
                Text(take.claim)
                    .font(.serif(18))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(take.author.handle(then: "\(take.risk.short) · \(take.tags.joined(separator: " / ").uppercased())"))
                    .font(.mono(11))
                    .foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Sparkline(values: take.history, color: Palette.sign(pct: take.ret))
                    .frame(width: 56, height: 20)
                Text(Fmt.pct(take.ret))
                    .font(.mono(13, .semibold))
                    .foregroundStyle(Palette.sign(pct: take.ret))
            }
        }
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// "Traders on X" on the Search page: the accounts you copy (tap for their calls) and a way to
/// add one. Opens Copy from X.
private struct XTradersRow: View {
    @Environment(AppState.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Traders on X").font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
                Spacer()
                NavigationLink { XCopyView() } label: {
                    Text(app.xAccounts.isEmpty ? "Add" : "See calls").font(.geist(13, .semibold)).foregroundStyle(Palette.up)
                }
                .accessibilityIdentifier("open-x-copy")
            }
            .padding(.horizontal, 16)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    NavigationLink { XCopyView() } label: {
                        VStack(spacing: 5) {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                                .frame(width: 52, height: 52)
                                .overlay(Circle().strokeBorder(Palette.muted.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4])))
                            Text("Copy").font(.geist(12)).foregroundStyle(Palette.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy a trader on X")

                    ForEach(app.xAccounts) { account in
                        NavigationLink { XCopyView() } label: {
                            VStack(spacing: 5) {
                                XAvatar(account: account, size: 52)
                                Text(account.username).font(.geist(12)).foregroundStyle(Palette.muted)
                                    .lineLimit(1).frame(maxWidth: 66)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("@\(account.username)")
                    }
                    if app.xAccounts.isEmpty {
                        Text("Copy traders on X: their calls show up as takes, ready to trade.")
                            .font(.geist(13)).foregroundStyle(Palette.muted)
                            .frame(width: 230, alignment: .leading)
                            .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .padding(.top, 4)
        // Again once sign-in finishes, so a cold start doesn't show an empty row.
        .task(id: app.isLive) { await app.refreshXAccounts() }
    }
}
