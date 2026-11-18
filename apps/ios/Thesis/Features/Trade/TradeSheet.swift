import SwiftUI

/// Trade or Fade a take. The sheet sits at a partial detent so iOS gives it the
/// Liquid Glass sheet material; amount presets are separate glass pills.
///
/// Any amount from $1 up to your balance (starts at $20). It comes out of your
/// balance and buys shares at the take's price (1 + its return); sell them any
/// time from the take page.
struct TradeSheet: View {
    let intent: TradeIntent

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var addingCash = false
    @State private var placing = false
    @State private var failure: String?
    @State private var placed = false
    @State private var amount = AppState.defaultTradeAmount
    @FocusState private var amountFocused: Bool

    private let presets: [Double] = [10, 20, 50, 100]

    init(intent: TradeIntent) {
        self.intent = intent
    }

    /// Fork mode: what the chain can trade right now, loaded when the sheet opens.
    @State private var receipt: ForkReceipt?

    private var take: Take { intent.take }
    private var side: Side { intent.side }
    private var tooSmall: Bool { amount < app.minTrade }
    /// Fork mode: the program's fee (the config account's rate, from the fork API) comes out of
    /// the wallet on top of the trade.
    private var fee: Double { app.isOnFork ? amount * (app.forkFeeRate ?? 0) : 0 }
    /// "0.10%", or nothing until the rate is known.
    private var feePercent: String {
        guard let rate = app.forkFeeRate else { return "" }
        return " " + (rate * 100).formatted(.number.precision(.fractionLength(2))) + "%"
    }
    /// The fee to the tenth of a cent ($0.025), since it's often below a cent's resolution.
    private var feeText: String { String(format: "$%.3f", fee) }
    private var shortOfCash: Bool { amount + fee > app.balance }
    /// "$50", or "$37.50" when there are cents.
    private var amountText: String { Fmt.usd(amount, cents: amount != amount.rounded()) }
    /// Fork mode: legs left out of this trade, by name, with the reason.
    private var forkLeftOut: [String: String] {
        guard app.isOnFork, let receipt else { return [:] }
        if side == .fade {
            // A fade holds a prediction leg's other side and shorts the rest on Phoenix, so what
            // counts is each leg's `fadeBlocked` (that side's market, or no Phoenix short), not the back's.
            let left = receipt.legs.compactMap { leg in leg.fadeBlocked.map { (leg.name, $0) } }
            return Dictionary(left, uniquingKeysWith: { a, _ in a })
        }
        return Dictionary(receipt.leftOut.map { ($0.name, $0.blocked ?? "Can't be traded on the fork yet") }, uniquingKeysWith: { a, _ in a })
    }
    private var forkBlocked: Bool { app.isOnFork && (receipt == nil || (side == .back ? !receipt!.canBack : !receipt!.canFade)) }
    /// The take as the chain sees it now: closed once its author sold (the feed's copy can be older).
    private var current: Take { take.updated(with: app.isOnFork ? receipt : nil) }
    private var legs: [Leg] {
        // On the fork the receipt says what can be faded; off it, the take's own fade notes do.
        let base = side == .back || app.isOnFork ? take.legs : take.legs.filter(\.canFade)
        return base.filter { forkLeftOut[$0.name] == nil }
    }
    private var excluded: [Leg] { take.legs.filter { !legs.contains($0) } }
    private func leftOutReason(_ leg: Leg) -> String {
        forkLeftOut[leg.name] ?? "There's no way to bet against this one"
    }
    private var total: Double { max(1, legs.reduce(0) { $0 + $1.weight }) }

    /// Fork mode: a prediction leg's Gemini market, from the receipt.
    private func forkPrediction(_ leg: Leg) -> ForkReceipt.Leg.Prediction? {
        guard app.isOnFork else { return nil }
        return receipt?.legs.first { $0.name == leg.name }?.prediction
    }

    /// "Yes · 47¢" (the side held, at its price now).
    private func predictionLine(_ p: ForkReceipt.Leg.Prediction) -> String {
        let fade = side == .fade
        let held = p.held(fade: fade) == "yes" ? "Yes" : "No"
        guard let price = p.price(fade: fade) else { return "\(held) on \(p.label)" }
        return "\(held) · \(Int((price * 100).rounded()))¢"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(side.title) \(take.author.name)'s take")
                            .font(.geist(26, .bold))
                        Text(side == .back
                             ? "You get the same basket at today's prices."
                             : "You win if \(take.author.name) is wrong. Fades are public, so the group will see it.")
                            .font(.geist(14))
                            .foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 15, weight: .semibold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Close")
                }

                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Amount").font(.geist(12)).foregroundStyle(Palette.muted)
                        TextField("Amount", value: $amount, format: .currency(code: "USD").precision(.fractionLength(0...2)))
                            .font(.geist(34, .bold))
                            .keyboardType(.decimalPad)
                            .monospacedDigit()
                            .focused($amountFocused)
                            .accessibilityIdentifier("trade-amount")
                    }
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 28))

                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            ForEach(presets, id: \.self) { value in
                                let on = amount == value
                                Button {
                                    amountFocused = false
                                    withAnimation(.snappy) { amount = value }
                                } label: {
                                    Text(Fmt.usd(value))
                                        .font(.mono(15, .semibold))
                                        .foregroundStyle(Palette.text)
                                        .frame(maxWidth: .infinity, minHeight: 48)
                                        .contentShape(Capsule())
                                }
                                .buttonStyle(.plain)
                                .glassEffect(on ? .regular.tint(side.fill.opacity(0.4)).interactive() : .regular.interactive(), in: .capsule)
                                .accessibilityAddTraits(on ? .isSelected : [])
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(side == .back ? "What you're buying" : "What you're betting")
                        .font(.geist(13, .medium))
                        .foregroundStyle(Palette.muted)
                    AllocationBar(legs: legs, height: 6, excludedWeight: excluded.reduce(0) { $0 + $1.weight })

                    VStack(spacing: 0) {
                        ForEach(legs) { leg in
                            HStack(spacing: 10) {
                                AssetLogo(key: leg.assetKey, name: leg.name, kind: leg.kind, size: 22, ring: Palette.series(leg.slot))
                                VStack(alignment: .leading, spacing: 1) {
                                    HStack(spacing: 6) {
                                        Text(leg.name).font(.geist(14))
                                        if side == .back {
                                            Text("\(Int(leg.weight))%").font(.mono(12)).foregroundStyle(Palette.muted)
                                        }
                                    }
                                    if let p = forkPrediction(leg) {
                                        // A prediction leg: the side this trade holds, at what it costs now.
                                        Text(predictionLine(p))
                                            .font(.geist(12)).foregroundStyle(Palette.muted)
                                            .accessibilityIdentifier("prediction-\(leg.name)")
                                    } else if side == .fade, let how = leg.fadeHow {
                                        Text(how).font(.geist(12)).foregroundStyle(Palette.muted)
                                    }
                                }
                                Spacer()
                                Text(Fmt.usd(amount * leg.weight / total, cents: true)).font(.mono(13, .semibold))
                            }
                            .frame(minHeight: side == .fade ? 46 : 38)
                        }
                        ForEach(excluded) { leg in
                            Hairline()
                            HStack(spacing: 10) {
                                RoundedRectangle(cornerRadius: 2)
                                    .strokeBorder(Palette.muted, style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(leg.name).font(.geist(14)).strikethrough()
                                    Text(leftOutReason(leg)).font(.geist(12))
                                }
                                Spacer()
                                Text("Left out").font(.geist(12, .semibold))
                            }
                            .foregroundStyle(Palette.muted)
                            .frame(minHeight: 46)
                        }
                        Hairline()
                        HStack {
                            if app.isOnFork {
                                Text("Bought from your wallet · Thesis fee\(feePercent)")
                                Spacer()
                                Text(feeText).font(.mono(13))
                            } else {
                                Text("At \(Fmt.usd(take.price, cents: true)) a share")
                                Spacer()
                                Text("\(String(format: "%.2f", take.price > 0 ? amount / take.price : 0)) shares").font(.mono(13))
                            }
                        }
                        .font(.geist(13))
                        .foregroundStyle(Palette.muted)
                        .frame(minHeight: 38)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 22)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: amount) { failure = nil }
        .safeAreaBar(edge: .bottom) {
            VStack(spacing: 10) {
                if let failure {
                    Label(failure, systemImage: "exclamationmark.circle")
                        .font(.geist(13, .medium))
                        .foregroundStyle(Palette.down)
                }
                if !current.isOpen {
                    SidePill(side: side, title: "Closed", height: 56, expand: true) {}
                        .disabled(true)
                        .opacity(0.5)
                } else if forkBlocked {
                    SidePill(side: side, title: receipt == nil ? "Checking the fork…" : "Not on the fork yet", height: 56, expand: true) {}
                        .disabled(true)
                        .opacity(0.5)
                } else if tooSmall {
                    SidePill(side: side, title: "\(side.title) at least \(Fmt.usd(app.minTrade))", height: 56, expand: true) {}
                        .disabled(true)
                        .opacity(0.5)
                } else if shortOfCash {
                    PrimaryGlassButton(title: "Add cash to \(side.title.lowercased()) \(amountText)", systemImage: "plus") {
                        addingCash = true
                    }
                    .sheet(isPresented: $addingCash) { AddCashView() }
                } else {
                    SidePill(side: side, title: placing ? "\(side == .back ? "Trading" : "Fading")…" : "\(side.title) for \(amountText)",
                             height: 56, expand: true, action: place)
                        .disabled(placing)
                }
                Text(!current.isOpen
                     ? current.closedReason
                     : forkBlocked
                     ? receipt?.missing ?? (side == .fade ? receipt?.fadeBlocked ?? "Loading what the fork can trade…" : "None of these legs can be traded on the fork yet.")
                     : tooSmall
                     ? "The smallest \(side.title.lowercased()) is \(Fmt.usd(app.minTrade))."
                     : shortOfCash
                     ? "You have \(Fmt.usd(app.balance, cents: true)). Add the rest in a few taps."
                     : "From your balance · \(Fmt.usd(app.balance - amount - fee, cents: true)) left")
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 8)
        }
        .task {
            if app.isOnFork {
                await app.loadForkConfig()
                receipt = await app.receipt(for: take)
            }
        }
        .presentationDetents([.fraction(0.9)])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(placing)
        .sensoryFeedback(.success, trigger: placed)
    }

    /// Places the trade; stays open with the reason if it doesn't go through.
    private func place() {
        guard !placing else { return }
        placing = true
        failure = nil
        Task {
            do {
                try await app.trade(take, side: side, amount: amount)
                placed = true
                dismiss()
            } catch {
                failure = CashErrorText.message(for: error)
                // Its author sold while the sheet was open: show it closed.
                if (error as? ForkAPIError)?.code == "take_closed" { receipt = await app.receipt(for: take) }
            }
            placing = false
        }
    }
}
