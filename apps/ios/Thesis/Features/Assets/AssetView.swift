import SwiftUI

/// One asset's page: price and chart, what it is, the details that matter for a basket, the takes
/// that hold it, and "Make a take with this".
struct AssetView: View {
    let assetID: String
    /// Off inside the composer (you're already making a take).
    var canStartTake = true

    @Environment(AppState.self) private var app
    @State private var page: AssetPage?
    @State private var takes: [Take] = []
    @State private var range: AssetRange = .month
    @State private var failed = false
    @State private var loadingChart = false
    @State private var scrub: Int?

    var body: some View {
        ScrollView {
            if let page {
                content(page)
            } else if failed {
                ContentUnavailableView("Couldn't load this", systemImage: "exclamationmark.triangle",
                                       description: Text("Check your connection and try again."))
                    .padding(.top, 80)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
            }
        }
        .background(ThesisBackground())
        .navigationTitle(page?.asset.symbol ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .task(id: range) { await loadChart() }
    }

    // MARK: Content

    @ViewBuilder private func content(_ page: AssetPage) -> some View {
        let a = page.asset
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                AssetLogo(key: a.key, name: a.name, kind: a.kind, size: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text(a.name).font(.serif(32)).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("asset-name")
                    Text("\(a.symbol) · \(a.kindLabel) · \(a.venue)").font(.geist(13)).foregroundStyle(Palette.muted)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            if let note = page.unavailableNote {
                Label(note, systemImage: "globe")
                    .font(.geist(13, .medium))
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Palette.tile, in: .capsule)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .accessibilityIdentifier("asset-unavailable")
            }

            priceBlock(page)

            // In the page, not pinned: the tab bar already has "What's your take?" at the bottom.
            if canStartTake && a.available {
                PrimaryGlassButton(title: "Make a take with this", systemImage: "plus") { app.startTake(with: a) }
                    .accessibilityIdentifier("asset-make-take")
                    .padding(.horizontal, 16)
                    .padding(.top, 20)
            }

            about(page)
            details(page)
            takesSection(a)
        }
        .padding(.bottom, 24)
    }

    @ViewBuilder private func priceBlock(_ page: AssetPage) -> some View {
        let a = page.asset
        if let apy = a.apyPct {
            VStack(alignment: .leading, spacing: 2) {
                Text("Earns \(Fmt.plainPct(apy)) a year").font(.geist(30, .bold))
                Text("The rate moves with demand to borrow. Your cash stays yours.").font(.geist(13)).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
        } else if let price = page.price {
            let values = page.chart
            let shown = scrub.flatMap { values.indices.contains($0) ? values[$0] : nil } ?? price
            let first = values.first ?? price
            let change = scrub == nil && range == .day ? page.change24hPct : (first > 0 ? (shown / first - 1) * 100 : nil)
            let color = Palette.sign(pct: change ?? 0)
            VStack(alignment: .leading, spacing: 2) {
                Text(Fmt.price(shown)).font(.geist(36, .bold)).contentTransition(.numericText())
                    .accessibilityIdentifier("asset-price")
                if let change {
                    Text("\(Fmt.pct(change)) \(rangeLabel)").font(.mono(13, .semibold))
                        .foregroundStyle(color)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)

            ZStack {
                if values.count > 1 {
                    PerformanceChart(values: values, color: color, height: 180, selection: $scrub)
                } else {
                    Text(loadingChart ? "" : "No price history yet")
                        .font(.geist(13)).foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, minHeight: 180)
                }
                if loadingChart { ProgressView() }
            }
            .padding(.top, 10)

            Picker("Range", selection: $range) {
                ForEach(AssetRange.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .accessibilityIdentifier("asset-range")
        }
    }

    private var rangeLabel: String {
        switch range {
        case .day: "today"
        case .week: "this week"
        case .month: "this month"
        case .year: "this year"
        }
    }

    @ViewBuilder private func about(_ page: AssetPage) -> some View {
        if let about = page.about, !about.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("What it is").font(.geist(17, .semibold))
                Text(about).font(.geist(15)).foregroundStyle(Palette.text.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                if !page.asset.themes.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(page.asset.themes.prefix(8), id: \.self) { theme in
                                Text(theme).font(.geist(12, .medium)).foregroundStyle(Palette.muted)
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(Palette.tile, in: .capsule)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 28)
        }
    }

    private func details(_ page: AssetPage) -> some View {
        let a = page.asset
        var rows: [(String, String)] = [("Type", a.kindLabel), ("Trades on", a.venue)]
        if let issuer = page.issuer, !issuer.isEmpty { rows.append(("Issued by", issuer)) }
        rows.append(("Fading it", page.fadeHow ?? "Can't be faded"))
        if let lev = a.maxLeverage { rows.append(("Up to", "\(Int(lev))x")) }
        if let ends = a.expiresAt { rows.append(("Resolves", ends.formatted(.dateTime.month(.abbreviated).day().year()))) }
        return VStack(alignment: .leading, spacing: 10) {
            Text("Details").font(.geist(17, .semibold))
            VStack(spacing: 0) {
                ForEach(rows.indices, id: \.self) { i in
                    if i > 0 { Hairline() }
                    HStack {
                        Text(rows[i].0).font(.geist(14)).foregroundStyle(Palette.muted)
                        Spacer(minLength: 12)
                        Text(rows[i].1).font(.geist(14, .medium)).multilineTextAlignment(.trailing)
                    }
                    .frame(minHeight: 44)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 28)
    }

    @ViewBuilder private func takesSection(_ a: Asset) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(takes.isEmpty ? "No takes with \(a.name) yet" : "Takes with \(a.name)")
                .font(.geist(17, .semibold))
                .padding(.horizontal, 16)
                .accessibilityIdentifier("asset-takes-title")
            if takes.isEmpty {
                Text(canStartTake && a.available ? "Be the first: make a take with it." : "")
                    .font(.geist(13)).foregroundStyle(Palette.muted)
                    .padding(.horizontal, 16)
            }
            ForEach(takes) { take in
                NavigationLink(value: take) { TakeListRow(take: take) }
                    .buttonStyle(.plain)
                Hairline()
            }
        }
        .padding(.top, 28)
    }

    // MARK: Loading

    private func load() async {
        guard page == nil else { return }
        async let found = app.takes(holding: assetID)
        do {
            page = try await app.assetPage(assetID, range: range)
        } catch {
            failed = true
        }
        takes = await found
    }

    /// A new range: the same page, its chart for that range.
    private func loadChart() async {
        guard let current = page, current.chartRange != range else { return }
        loadingChart = true
        defer { loadingChart = false }
        scrub = nil
        if let next = try? await app.assetPage(assetID, range: range) {
            page?.chart = next.chart
            page?.chartRange = range
            page?.price = next.price ?? current.price
        }
    }
}

/// An asset in a list: name, ticker and type, and its price and day change.
struct AssetRow: View {
    let asset: Asset
    /// Shown instead of the price ("In your basket").
    var trailingNote: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            AssetLogo(key: asset.key, name: asset.name, kind: asset.kind, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(asset.name).font(.geist(15, .semibold)).lineLimit(1)
                Text(asset.available ? asset.subtitle : "Not available in the US yet")
                    .font(.geist(12)).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            if let trailingNote {
                Text(trailingNote).font(.geist(12, .medium)).foregroundStyle(Palette.muted)
            } else if let price = asset.priceUSD {
                VStack(alignment: .trailing, spacing: 3) {
                    Text(Fmt.price(price)).font(.mono(13, .semibold))
                    if let ch = asset.change24hPct {
                        Text(Fmt.pct(ch)).font(.mono(11)).foregroundStyle(Palette.sign(pct: ch))
                    }
                }
            }
        }
        .foregroundStyle(Palette.text)
        .opacity(asset.available ? 1 : 0.55)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "+ Add a pick": search everything you can buy and add one to the basket.
struct AssetPickerView: View {
    let legs: [Leg]
    let onPick: (Asset) -> Void

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Asset] = []
    @State private var searching = false
    @State private var about: Asset?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(results) { asset in
                        let inBasket = BasketMath.contains(asset, in: legs)
                        Button {
                            onPick(asset)
                            dismiss()
                        } label: {
                            AssetRow(asset: asset, trailingNote: inBasket ? "In your basket" : nil)
                        }
                        .buttonStyle(.plain)
                        .disabled(inBasket || !asset.available)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing) {
                            Button("About", systemImage: "info.circle") { about = asset }.tint(Palette.muted)
                        }
                    }
                } header: {
                    Text(query.isEmpty ? "Most traded" : "Results").font(.geist(13, .semibold))
                }
                if results.isEmpty && !searching && !query.isEmpty {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(ThesisBackground())
            .overlay { if searching && results.isEmpty { ProgressView() } }
            .navigationTitle("Add a pick")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Ticker, company or idea")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task(id: query) { await search() }
            .sheet(item: $about) { asset in
                NavigationStack {
                    AssetView(assetID: asset.id, canStartTake: false)
                        .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
                }
            }
        }
    }

    private func search() async {
        if !query.isEmpty {
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
        }
        searching = true
        defer { searching = false }
        if let found = try? await app.searchAssets(query), !Task.isCancelled { results = found }
    }
}
