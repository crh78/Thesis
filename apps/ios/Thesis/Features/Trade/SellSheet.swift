import SwiftUI
import os

/// The trade sheet's Sell tab: sells part or all of what you hold in this take, on either side
/// you hold. In % (25, 50, 75, All) or $ ($10, $25, $50, All), or a typed amount. Selling part of
/// it has to leave at least the minimum stake ($10) in the position, so larger parts are disabled
/// (and why is said); a position that small sells all at once. Selling all of the author's own
/// buy-in closes the take, which it says at All.
///
/// Fork mode: the sale is built before the tap like a trade (as the tab opens, at once on a
/// preset, half a second after typing stops) and kept fresh, so the tap only signs and sends it:
/// one build and one approval for the whole holding (`/takes/:id/sell`). It shows "Sold" once the
/// fork accepts it; if it then doesn't land, the sheet (or a banner, once it's closed) says so.
/// A fork API from before partial sales (no partial-sale fields on the receipt, no `/sell` route,
/// or a sale build without `bps` / `full`) sells only all of it, one whole position at a time.
///
/// Mock data: sells at today's price; the money goes back into your balance.
struct SellPanel: View {
    let take: Take
    @Binding var tab: TradeTab

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    private enum Mode: Hashable { case pct, usd }

    @State private var side: Side
    @State private var mode: Mode = .pct
    /// The amount picked or typed: a percent in % mode, dollars in $ mode. Starts at all of it.
    @State private var typed: Double = 100
    @FocusState private var typing: Bool
    /// Fork mode: what you hold, from the take's receipt.
    @State private var receipt: ForkReceipt?
    @State private var loaded = false
    @State private var prebuilds: Prebuilds<SaleKey>?
    /// The builds ready for the amount now: what the sale is expected to pay.
    @State private var quotes: [ForkBuild] = []
    /// This fork API turned out to sell whole positions only.
    @State private var wholeOnly = false
    /// The fork API's own limit, by side, from a sale that asked for too much (0: only all of it).
    @State private var serverMax: [Side: Int] = [:]
    @State private var selling = false
    @State private var failure: String?
    /// Sales the fork accepted (build ids), while the sheet shows "Sold".
    @State private var confirming: [String] = []
    @State private var sold = false
    /// The app is in front: builds are kept fresh only then.
    @State private var active = true

    private static let log = Logger(subsystem: "xyz.yourthesis.app", category: "trade")
    private static let pctPresets: [Double] = [25, 50, 75]
    private static let usdPresets: [Double] = [10, 25, 50]

    init(take: Take, side: Side, tab: Binding<TradeTab>) {
        self.take = take
        _tab = tab
        _side = State(initialValue: side)
    }

    // MARK: What you hold

    private var holdings: [SellHolding] {
        guard app.isOnFork else {
            return [Side.back, .fade].compactMap { app.position(in: take, side: $0) }.map(SellHolding.init(mock:))
        }
        return ForkReceipt.MyHolding.group(receipt?.viewerPositions ?? [])
            .filter { !$0.exited && !$0.addresses.allSatisfy(app.soldPositions.contains) }
            .map { h in
                let side: Side = h.side == "fade" ? .fade : .back
                return SellHolding(fork: h, minimum: app.minTrade, serverMax: serverMax[side],
                                   selling: app.isSelling(takeID: take.id, side: side))
            }
    }

    /// The holding being sold: the side asked for, or the one you hold.
    private var holding: SellHolding? { holdings.first { $0.side == side } ?? holdings.first }

    private var partialOK: Bool { holding?.partialSales == true && !wholeOnly }
    /// The largest partial sale allowed now (nil: only all of it).
    private var maxBps: Int? { partialOK ? holding?.maxPartialBps : nil }
    private var worth: Double? { holding?.valueUsd }

    // MARK: The amount

    /// The share of the holding the amount sells, in bps; nil when there's none, or it's in
    /// dollars and the holding has no value yet (the fork API converts it then).
    private var bps: Int? {
        guard typed > 0 else { return nil }
        switch mode {
        case .pct: return min(max(Int((typed * 100).rounded()), 1), SaleLimits.all)
        case .usd: return worth.map { SaleLimits.bps(usd: typed, value: $0) }
        }
    }
    private var isAll: Bool { bps == SaleLimits.all }
    private var amount: SellAmount? {
        guard typed > 0 else { return nil }
        if isAll { return .all }
        switch mode {
        case .pct: return bps.map(SellAmount.bps)
        case .usd: return .usd(cents: Int((typed * 100).rounded()))
        }
    }

    /// Why this amount can't be sold, if it can't.
    private var blocked: String? {
        guard let holding, amount != nil else { return "Enter an amount to sell." }
        if isAll { return nil }
        if !partialOK { return "This fork sells whole positions only. Sell all of it instead." }
        let keep = "A position has to keep at least \(Fmt.usd(holding.minStakeUsd))"
        guard let maxBps else { return "\(keep), so this one sells all at once." }
        if let bps, bps > maxBps { return "\(keep). Sell up to \(limitText(maxBps)), or all of it." }
        return nil
    }

    /// "50% ($11.40)", or "50%" while it has no value.
    private func limitText(_ bps: Int) -> String {
        let pct = "\(Int((Double(bps) / 100).rounded(.down)))%"
        guard let worth else { return pct }
        return "\(pct) (\(Fmt.usd(worth * Double(bps) / Double(SaleLimits.all), cents: true)))"
    }

    /// What the sale is expected to pay: the build's quote, or the holding's value now.
    private var proceeds: Double? {
        if !quotes.isEmpty, quotes.allSatisfy({ $0.expectedUsd != nil }) { return quotes.reduce(0) { $0 + ($1.expectedUsd ?? 0) } }
        guard let worth, let bps else { return mode == .usd && !isAll && typed > 0 ? typed : nil }
        let value = worth * Double(bps) / Double(SaleLimits.all)
        return (value * 100).rounded() / 100
    }
    private var minimum: Double? {
        guard !quotes.isEmpty, quotes.allSatisfy({ $0.minimumUsd != nil }) else { return nil }
        return quotes.reduce(0) { $0 + ($1.minimumUsd ?? 0) }
    }
    private var closesTake: Bool { isAll && (holding?.closesTakeIfSoldAll == true || quotes.contains { $0.closesTake == true }) }

    // MARK: Builds

    /// What the amount's sale is built as: part or all of the holding, or each whole position on an
    /// old fork API.
    private var keys: [SaleKey] {
        guard let holding, let amount, blocked == nil else { return [] }
        if !partialOK { return holding.addresses.map(SaleKey.position) }
        return [.holding(holding.side, amount)]
    }
    private var canPrebuild: Bool {
        app.isOnFork && holding?.canSell == true && confirming.isEmpty && !selling
    }
    private func prebuild() {
        guard canPrebuild else { return }
        keys.forEach { prebuilds?.want($0) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 14) {
                    TradeSheetTop(tab: $tab, busy: selling || !confirming.isEmpty)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(holding.map { $0.side == .back ? "Sell your trade" : "Sell your fade" } ?? "Sell")
                            .font(.geist(26, .bold))
                        Text(take.claim).font(.serif(16)).foregroundStyle(Palette.muted).lineLimit(2)
                    }
                }
                if let holding {
                    if holdings.count > 1 {
                        Picker("Which position", selection: $side) {
                            ForEach(holdings) { h in
                                Text(h.side == .back ? "Your trade" : "Your fade").tag(h.side)
                            }
                        }
                        .pickerStyle(.segmented)
                        .disabled(selling || !confirming.isEmpty)
                        .accessibilityIdentifier("sell-side")
                    }
                    HoldingFigures(holding: holding)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                        .glassEffect(.regular, in: .rect(cornerRadius: 24))
                    amountPicker(holding)
                    if closesTake {
                        Label("Selling all of it closes this take: no new trades, and its result is final at today's prices. Others keep their positions.",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.geist(14, .medium))
                            .foregroundStyle(Palette.text)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassEffect(.regular, in: .rect(cornerRadius: 18))
                            .accessibilityIdentifier("sell-closes-take")
                    }
                    if app.isOnFork, let proceeds {
                        VStack(spacing: 6) {
                            LabeledContent("Estimated proceeds", value: Fmt.usd(proceeds, cents: true))
                                .accessibilityElement(children: .combine)
                                .accessibilityIdentifier("sell-estimate")
                            if let minimum {
                                LabeledContent("Minimum after slippage", value: Fmt.usd(minimum, cents: true))
                                    .accessibilityElement(children: .combine)
                                    .accessibilityIdentifier("sell-minimum")
                            }
                        }
                        .font(.geist(14))
                    }
                } else if app.isOnFork && !loaded {
                    ThesisInlineLoader(text: "Checking what you hold…")
                } else {
                    Text("You don't hold this take. Buy in and you can sell it here, all of it or part.")
                        .font(.geist(15))
                        .foregroundStyle(Palette.muted)
                        .accessibilityIdentifier("sell-nothing")
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 22)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .bottom) {
            if let holding { bottomBar(holding).padding(.horizontal, 18).padding(.bottom, 8) }
        }
        .onChange(of: typed) { changed() }
        .onChange(of: mode) { changed() }
        .onChange(of: side) { changed() }
        .task {
            if let held = holding?.side { side = held }
            guard app.isOnFork else { return }
            let app = app
            prebuilds = .sales(app, takeID: take.id)
            await app.loadForkConfig()
            receipt = await app.receipt(for: take)
            loaded = true
            if let held = holding?.side, holdings.allSatisfy({ $0.side != side }) { side = held }
            prebuild()
            // Keeps the amount's build fresh while the sheet is up and the app in front, and shows its quote.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard active, confirming.isEmpty, !selling else { continue }
                if canPrebuild { keys.forEach { prebuilds?.tick($0) } }
                let ready = keys.compactMap { prebuilds?.readyBuild($0)?.build }
                // A sale build without bps / full: a fork API from before partial sales.
                if case .holding? = keys.first, let build = ready.first, !build.knowsPartialSales { wholeOnly = true }
                quotes = ready.count == keys.count ? ready : []
            }
        }
        .task(id: "\(mode)|\(typed)|\(side)") {
            // Typing: build half a second after it stops (a preset already did, at once).
            try? await Task.sleep(for: .milliseconds(500))
            if !Task.isCancelled { prebuild() }
        }
        .onChange(of: scenePhase) { _, phase in active = phase == .active }
        .onDisappear { confirming.forEach { app.sheetShows($0, false) } }
        .interactiveDismissDisabled(selling)
        .sensoryFeedback(.success, trigger: sold)
    }

    private func changed() {
        failure = nil
        quotes = []
    }

    // MARK: Amount

    @ViewBuilder
    private func amountPicker(_ holding: SellHolding) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Amount to sell").font(.geist(12)).foregroundStyle(Palette.muted)
                    Group {
                        if mode == .pct {
                            HStack(spacing: 2) {
                                TextField("Percent", value: $typed, format: .number.precision(.fractionLength(0...2)))
                                    .fixedSize()
                                Text("%").foregroundStyle(Palette.muted)
                            }
                        } else {
                            TextField("Amount", value: $typed,
                                      format: .currency(code: "USD").precision(.fractionLength(typed == typed.rounded() ? 0 : 2)))
                        }
                    }
                    .font(.geist(34, .bold))
                    .keyboardType(.decimalPad)
                    .monospacedDigit()
                    .focused($typing)
                    .accessibilityIdentifier("sell-amount")
                }
                Spacer()
                Picker("Sell by", selection: modeBinding) {
                    Text("%").tag(Mode.pct)
                    Text("$").tag(Mode.usd)
                }
                .pickerStyle(.segmented)
                .frame(width: 96)
                .accessibilityIdentifier("sell-mode")
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
            .glassEffect(.regular, in: .rect(cornerRadius: 28))

            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    ForEach(mode == .pct ? Self.pctPresets : Self.usdPresets, id: \.self) { value in
                        preset(mode == .pct ? "\(Int(value))%" : Fmt.usd(value), value: value, holding: holding)
                    }
                    preset("All", value: nil, holding: holding)
                }
            }
            // Why some parts can't be sold.
            if let note = limitNote(holding) {
                Text(note)
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                    .accessibilityIdentifier("sell-limit")
            }
        }
    }

    /// Switching % / $ keeps the amount: 50% of $22.80 becomes $11.40, and back.
    private var modeBinding: Binding<Mode> {
        Binding(get: { mode }, set: { new in
            guard new != mode else { return }
            let share = isAll ? 1 : bps.map { Double($0) / Double(SaleLimits.all) }
            switch new {
            case .usd: typed = share.flatMap { s in worth.map { ($0 * s * 100).rounded() / 100 } } ?? 10
            case .pct: typed = share.map { ($0 * 10_000).rounded() / 100 } ?? 100
            }
            mode = new
        })
    }

    /// A preset's share of the holding in bps (all of it for All), or nil when that's unknown.
    private func presetBps(_ value: Double?) -> Int? {
        guard let value else { return SaleLimits.all }
        switch mode {
        case .pct: return Int(value * 100)
        case .usd: return worth.map { SaleLimits.bps(usd: value, value: $0) }
        }
    }

    private func preset(_ label: String, value: Double?, holding: SellHolding) -> some View {
        let share = presetBps(value)
        let on = value == nil ? isAll : (abs(typed - value!) < 0.001 && !isAll)
        // Parts above the limit (or more than it's worth) are off; All always works.
        let off = value != nil && (!partialOK || maxBps == nil || share.map { $0 >= SaleLimits.all || $0 > maxBps! } ?? false)
        return Button {
            typing = false
            withAnimation(.snappy) {
                if let value { typed = value } else { typed = mode == .pct ? 100 : ((worth ?? holding.heldStakeUsd) * 100).rounded() / 100 }
            }
            prebuild() // a preset builds at once; typing waits
        } label: {
            Text(label)
                .font(.mono(15, .semibold))
                .foregroundStyle(off ? Palette.muted : Palette.text)
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(on ? .regular.tint(holding.side.fill.opacity(0.4)).interactive() : .regular.interactive(), in: .capsule)
        .disabled(off || selling || !confirming.isEmpty)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// Why parts of it can't be sold: "Up to 50% ($11.40): a position keeps at least $10."
    private func limitNote(_ holding: SellHolding) -> String? {
        if !partialOK { return wholeOnly || app.isOnFork ? "This fork sells whole positions only." : nil }
        let keep = "a position keeps at least \(Fmt.usd(holding.minStakeUsd))"
        guard let maxBps else { return "All at once: \(keep)." }
        let capped = (mode == .pct ? Self.pctPresets : Self.usdPresets).contains { v in
            presetBps(v).map { $0 > maxBps } ?? false
        }
        guard capped || (bps.map { $0 > maxBps && $0 < SaleLimits.all } ?? false) else { return nil }
        return "Up to \(limitText(maxBps)), or all of it: \(keep)."
    }

    // MARK: Bottom

    @ViewBuilder
    private func bottomBar(_ holding: SellHolding) -> some View {
        VStack(spacing: 10) {
            if let failure {
                Label(failure, systemImage: "exclamationmark.circle")
                    .font(.geist(13, .medium))
                    .foregroundStyle(Palette.down)
                    .accessibilityIdentifier("sell-failure")
            }
            if !confirming.isEmpty {
                Label(isAll ? "Sold · Confirming on-chain…" : "Selling · Confirming on-chain…", systemImage: "checkmark.circle.fill")
                    .font(.geist(15, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .accessibilityIdentifier("sell-sold")
            } else if !holding.canSell {
                PrimaryGlassButton(title: "Can't sell yet") {}
                    .disabled(true)
            } else if holding.selling && app.isOnFork {
                PrimaryGlassButton(title: "Selling…") {}
                    .disabled(true)
            } else {
                PrimaryGlassButton(title: buttonTitle, action: sell)
                    .disabled(selling || blocked != nil)
                    .accessibilityIdentifier("sell-confirm")
            }
            Text(caption(holding))
                .font(.geist(13))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
        }
    }

    private var buttonTitle: String {
        if selling { return "Selling…" }
        if worth == 0 { return "Close position" }
        if isAll { return proceeds.map { "Sell all for \(Fmt.usd($0, cents: true))" } ?? "Sell all" }
        if blocked != nil, amount != nil { return "Sell up to \(maxBps.map(limitText) ?? "all")" }
        if let proceeds { return "Sell \(Fmt.usd(proceeds, cents: true))" }
        return bps.map { "Sell \($0 / 100)%" } ?? "Sell"
    }

    private func caption(_ holding: SellHolding) -> String {
        if !confirming.isEmpty { return isAll ? "The whole position is sold." : "Part of it is sold; the rest stays in." }
        if let blocked { return blocked }
        if worth == 0 { return "It's worth $0 now, so there's nothing to pay out." }
        let share = Double(bps ?? SaleLimits.all) / Double(SaleLimits.all)
        let keeps = isAll ? "" : " · keeps \(Fmt.usd(holding.heldStakeUsd * (1 - share), cents: true)) in"
        guard !app.isOnFork else {
            // A sale is scored at its own prices; prediction legs' held money comes back too.
            return "Sold for fork USDC at today's prices\(keeps)"
        }
        guard let proceeds, let pnl = holding.pnlUsd else { return "Goes to your balance\(keeps)" }
        let made = pnl * share
        let says = abs(made) < 0.005 ? "No gain or loss" : made > 0 ? "You make \(Fmt.usd(made, cents: true))" : "You lose \(Fmt.usd(-made, cents: true))"
        return "\(says) · \(Fmt.usd(proceeds, cents: true)) goes to your balance\(keeps)"
    }

    // MARK: Selling

    private func sell() {
        guard !selling, confirming.isEmpty, let holding, let amount, blocked == nil else { return }
        selling = true
        failure = nil
        Task {
            if app.isOnFork { await sellOnFork(holding, amount) } else { await sellMock(holding) }
            selling = false
        }
    }

    /// Signs and sends the sale built ahead (or builds it now if there's none fresh).
    private func sellOnFork(_ holding: SellHolding, _ amount: SellAmount) async {
        let marks = TradeMarks()
        do {
            guard let prebuilds else { throw SocialAPIError.invalid("fork_unavailable") }
            let ids = try await app.commitSale(takeID: take.id, side: holding.side, amount: amount, addresses: holding.addresses,
                                               wholePositionsOnly: !partialOK, prebuilds: prebuilds, marks: marks)
            marks.mark("shown")
            Self.log.info("sale shown: \(marks.values.description, privacy: .public)")
            await showSold(ids)
        } catch {
            if let e = error as? ForkAPIError {
                // The fork API's own limit, so the presets above it turn off.
                if e.code == "remainder_below_minimum" { serverMax[holding.side] = e.maxPartialBps ?? 0 }
                if e.code == "whole_positions_only" { wholeOnly = true }
            }
            failure = Self.friendly(error)
            // What's left to sell, as the chain has it now.
            receipt = await app.receipt(for: take)
            prebuild()
        }
    }

    private func sellMock(_ holding: SellHolding) async {
        guard let position = app.position(in: take, side: holding.side) else {
            failure = CashErrorText.message(for: SocialAPIError.invalid("no_position"))
            return
        }
        do {
            try await app.sell(position, amount: isAll ? nil : proceeds)
            sold.toggle()
            dismiss()
        } catch {
            failure = CashErrorText.message(for: error)
        }
    }

    /// The fork's errors are developer text ("Transaction simulation failed: Blockhash not found…").
    private static func friendly(_ error: Error) -> String {
        let text = CashErrorText.message(for: error)
        if text.contains("Blockhash not found") || text.contains("block height exceeded") {
            return "The quote expired before it was sent. Try again."
        }
        if text.contains("Simulation failed") || text.contains("simulation failed") {
            return "The sale didn't go through: prices moved past the slippage limit. Try again."
        }
        return text
    }

    /// "Sold · Confirming on-chain…" until the sales land (or a moment passes), then the sheet
    /// closes. A sale that doesn't land while it's open is said here; later, the banner does.
    private func showSold(_ ids: [String]) async {
        ids.forEach { app.sheetShows($0, true) }
        confirming = ids
        selling = false
        sold.toggle()
        let until = Date.now.addingTimeInterval(1.5)
        func ended(_ id: String) -> Bool { app.pendingTrades[id].map { $0.status != .confirming } ?? true }
        while Date.now < until, !ids.allSatisfy(ended) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        let failed = ids.compactMap { id -> String? in
            switch app.pendingTrades[id]?.status {
            case .failed(let message)?, .incomplete(let message)?: message
            default: nil
            }
        }
        ids.forEach { app.sheetShows($0, false) }
        confirming = []
        if let message = failed.first {
            failure = message
            receipt = await app.receipt(for: take)
            prebuild()
        } else {
            dismiss()
        }
    }
}

/// What you hold on one side: worth now, gain, what you still have in, and what partial sales sold.
struct HoldingFigures: View {
    let holding: SellHolding

    var body: some View {
        let h = holding
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Worth now").font(.geist(12)).foregroundStyle(Palette.muted)
                    Text(h.valueUsd.map { Fmt.usd($0, cents: true) } ?? "pricing…").font(.geist(28, .bold)).monospacedDigit()
                }
                Spacer()
                if let pnl = h.pnlUsd {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(pnl >= 0 ? "Gain" : "Loss").font(.geist(12)).foregroundStyle(Palette.muted)
                        Text(Fmt.usd(pnl, cents: true, signed: true))
                            .font(.mono(15, .semibold))
                            .foregroundStyle(pnl >= 0 ? Palette.up : Palette.down)
                    }
                }
            }
            Hairline()
            figure("You have in", h.soldStakeUsd > 0.005
                   ? "\(Fmt.usd(h.heldStakeUsd, cents: true)) of \(Fmt.usd(h.stakeUsd, cents: true))"
                   : Fmt.usd(h.heldStakeUsd, cents: true))
            if let realized = h.realizedPnlUsd {
                figure("Realized from sales", Fmt.usd(realized, cents: true, signed: true))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sell-holding")
    }

    private func figure(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.geist(13)).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(.mono(13))
        }
    }
}

/// Worth now, gain, what you put in, and the prices behind it (mock data's take page).
struct PositionFigures: View {
    let position: OwnedPosition

    var body: some View {
        let p = position
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Worth now").font(.geist(12)).foregroundStyle(Palette.muted)
                    Text(Fmt.usd(p.value, cents: true)).font(.geist(28, .bold)).monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(p.pnl >= 0 ? "Gain" : "Loss").font(.geist(12)).foregroundStyle(Palette.muted)
                    Text("\(Fmt.usd(p.pnl, cents: true, signed: true)) (\(Fmt.pct(p.ret)))")
                        .font(.mono(15, .semibold))
                        .foregroundStyle(p.pnl >= 0 ? Palette.up : Palette.down)
                }
            }
            Hairline()
            figure("You put in", Fmt.usd(p.amount, cents: true))
            figure("Price", "\(Fmt.usd(p.avgPrice, cents: true)) avg → \(Fmt.usd(p.price, cents: true)) now")
            figure("Shares", String(format: "%.2f", p.shares))
        }
        .accessibilityElement(children: .combine)
    }

    private func figure(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.geist(13)).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(.mono(13))
        }
    }
}
