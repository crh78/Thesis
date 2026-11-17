import SwiftUI

/// Fork mode: the take's on-chain receipt. Counts and money in come from the Thesis program on
/// the mainnet fork; the return is the author's position at current prices (or the settled result).
struct ForkReceiptView: View {
    let receipt: ForkReceipt?
    /// Sell: the on-chain positions behind one of your holdings (every buy is its own position).
    var onExit: (([String]) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("On-chain receipt").font(.geist(17, .semibold))
                Spacer()
                Text(statusText).font(.mono(11)).foregroundStyle(Palette.muted)
            }
            if let receipt {
                if receipt.onChain {
                    stats(receipt)
                    if let address = receipt.address {
                        Text("Take \(address.prefix(4))…\(address.suffix(4)) on the mainnet fork")
                            .font(.mono(11))
                            .foregroundStyle(Palette.muted)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("Not on-chain yet. The first trade puts it there.")
                        .font(.geist(13))
                        .foregroundStyle(Palette.muted)
                }
                legs(receipt)
                positions(receipt)
            } else {
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityIdentifier("fork-receipt")
    }

    private var statusText: String {
        guard let receipt else { return "LOADING" }
        guard receipt.onChain else { return "FORK · NOT POSTED" }
        return receipt.status == "settled" ? "FORK · SETTLED" : "FORK · LIVE"
    }

    private func stats(_ r: ForkReceipt) -> some View {
        HStack(spacing: 0) {
            stat("Backers", "\(r.backers ?? 0)")
            stat("Faders", "\(r.faders ?? 0)")
            stat("Money in", Fmt.usd((r.totalBackedUsd ?? 0) + (r.totalFadedUsd ?? 0)))
            stat("Return", r.returnBps.map { Fmt.pct(Double($0) / 100) } ?? "—",
                 color: r.returnBps.map { Palette.sign(pct: Double($0) / 100) })
        }
    }

    private func stat(_ label: String, _ value: String, color: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.geist(12)).foregroundStyle(Palette.muted)
            Text(value).font(.mono(15, .semibold)).foregroundStyle(color ?? Palette.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func legs(_ r: ForkReceipt) -> some View {
        VStack(spacing: 8) {
            ForEach(r.legs, id: \.index) { leg in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(leg.name).font(.geist(14)).lineLimit(1)
                        .foregroundStyle(leg.tradable ? Palette.text : Palette.muted)
                    Spacer(minLength: 4)
                    if leg.tradable {
                        Text(priceText(leg)).font(.mono(12)).foregroundStyle(Palette.muted)
                    } else {
                        Text(leg.blocked ?? "Not tradable yet").font(.geist(12)).foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.trailing)
                    }
                }
            }
        }
    }

    /** The score's return (what counts on-chain), or why it isn't in yet. */
    private func scoreLine(_ p: ForkReceipt.MyHolding) -> String {
        if let note = p.pendingNote { return note }
        guard let bps = p.returnBps else { return "Score: pricing…" }
        return "Score \(Fmt.pct(Double(bps) / 100)) · on-chain prices"
    }

    private func priceText(_ leg: ForkReceipt.Leg) -> String {
        switch (leg.authorEntryUsd, leg.currentUsd) {
        case let (entry?, now?): "\(Fmt.usd(entry, cents: true)) → \(Fmt.usd(now, cents: true))"
        case let (entry?, nil): "in at \(Fmt.usd(entry, cents: true))"
        case let (nil, now?): "now \(Fmt.usd(now, cents: true))"
        default: "pricing…"
        }
    }

    @ViewBuilder
    private func positions(_ r: ForkReceipt) -> some View {
        let mine = ForkReceipt.MyHolding.group(r.viewerPositions ?? [])
        if !mine.isEmpty {
            Hairline()
            ForEach(mine) { p in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(p.side == "back" ? "You traded \(Fmt.usd(p.stakeUsd))" : "You faded \(Fmt.usd(p.stakeUsd))")
                            .font(.geist(14))
                        Spacer()
                        // What the wallet holds now against what it paid (fee included).
                        if p.exited {
                            Text("Sold").font(.mono(13, .semibold))
                        } else if let pnl = p.pnl, let value = p.valueUsd {
                            Text("\(Fmt.usd(value, cents: true)) · \(Fmt.pct(pnl.pct * 100))")
                                .font(.mono(13, .semibold))
                                .foregroundStyle(pnl.usd >= 0 ? Palette.up : Palette.down)
                        } else {
                            Text(p.returnBps.map { Fmt.pct(Double($0) / 100) } ?? "pricing…")
                                .font(.mono(13, .semibold))
                                .foregroundStyle(p.returnBps.map { Palette.sign(pct: Double($0) / 100) } ?? Palette.muted)
                        }
                    }
                    // Leveraged legs: where each one is liquidated, and how close the market is.
                    ForEach(p.phoenix, id: \.leg) { risk in
                        liquidationLine(risk, legName: r.legs.first { $0.index == risk.leg }?.name ?? risk.symbol)
                    }
                    if p.canExit, let onExit {
                        Button("Sell position") { onExit(p.addresses) }
                            .font(.geist(13, .semibold))
                            .buttonStyle(.bordered)
                    }
                    Text(scoreLine(p))
                        .font(.geist(12))
                        .foregroundStyle(Palette.muted)
                }
            }
        }
    }

    /// "NVIDIA perp liquidates at $61.21 · 18% away", warning-colored when it's near (25%) or close (10%).
    private func liquidationLine(_ risk: ForkReceipt.Holding.PhoenixRisk, legName: String) -> some View {
        let away = risk.distance.map { " · \(Int(max(0, $0 * 100).rounded()))% away" } ?? ""
        let at = risk.liquidationUsd.map { "liquidates at \(Fmt.usd($0, cents: true))" } ?? "can't be liquidated by price alone"
        let alarming = risk.level != "ok"
        return HStack(spacing: 6) {
            if alarming {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
            }
            Text("\(legName) \(at)\(away)")
                .font(.geist(12, alarming ? .semibold : .regular))
        }
        .foregroundStyle(risk.level == "close" ? Palette.down : alarming ? Palette.text : Palette.muted)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(alarming ? "Warning: \(legName) \(at)\(away)" : "\(legName) \(at)\(away)")
    }
}

extension ForkReceipt {
    /// Your stake on one side of this take, however many times you bought it. Open buys add up into
    /// one holding (return weighted by stake); sold ones stay as they were.
    struct MyHolding: Identifiable {
        let addresses: [String]
        let side: String
        let stakeUsd: Double
        let costUsd: Double?
        let valueUsd: Double?
        let returnBps: Int?
        let pendingNote: String?
        let canExit: Bool
        let exited: Bool
        /// Each leveraged leg's liquidation risk; across several buys, the one closest to it.
        let phoenix: [Holding.PhoenixRisk]

        var id: String { addresses.joined(separator: ",") }

        var pnl: (usd: Double, pct: Double)? {
            guard let costUsd, let valueUsd, costUsd > 0 else { return nil }
            return (valueUsd - costUsd, valueUsd / costUsd - 1)
        }

        private static func closest(_ risks: [Holding.PhoenixRisk]) -> [Holding.PhoenixRisk] {
            var byLeg: [Int: Holding.PhoenixRisk] = [:]
            for r in risks {
                if let kept = byLeg[r.leg], (kept.distance ?? .infinity) <= (r.distance ?? .infinity) { continue }
                byLeg[r.leg] = r
            }
            return byLeg.keys.sorted().compactMap { byLeg[$0] }
        }

        static func group(_ positions: [Holding]) -> [MyHolding] {
            // Open buys on a side are one holding, and so are the ones already sold.
            var groups: [String: [Holding]] = [:]
            var order: [String] = []
            for p in positions {
                let key = "\(p.exited == true ? "sold" : "open")|\(p.side)"
                if groups[key] == nil { order.append(key) }
                groups[key, default: []].append(p)
            }
            let merged = order.compactMap { key -> MyHolding? in
                guard let group = groups[key], let first = group.first else { return nil }
                func total(_ value: (Holding) -> Double?) -> Double? {
                    let values = group.compactMap(value)
                    return values.count == group.count ? values.reduce(0, +) : nil
                }
                let stake = group.reduce(0) { $0 + $1.stakeUsd }
                let returns = group.compactMap { p in p.returnBps.map { Double($0) * p.stakeUsd } }
                return MyHolding(
                    addresses: group.map(\.address), side: first.side, stakeUsd: stake,
                    costUsd: total(\.costUsd), valueUsd: total(\.valueUsd),
                    returnBps: returns.count == group.count && stake > 0 ? Int((returns.reduce(0, +) / stake).rounded()) : nil,
                    pendingNote: group.lazy.compactMap(\.pendingNote).first,
                    // Sell sells all of them, so every one has to be sellable.
                    canExit: first.exited != true && group.allSatisfy { $0.canExit == true },
                    exited: first.exited == true,
                    phoenix: first.exited == true ? [] : closest(group.flatMap { $0.phoenix ?? [] }))
            }
            // Open holdings first, then what was sold.
            return merged.filter { !$0.exited } + merged.filter(\.exited)
        }
    }
}
