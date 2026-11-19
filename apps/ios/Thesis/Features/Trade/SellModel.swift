import Foundation

/// The trade sheet's two tabs: Buy (trade or fade more) opens first, Sell sells what you hold.
enum TradeTab: Hashable { case buy, sell }

/// How much a sale sells: a share of the holding in bps (10,000 = all of it), or dollars of it
/// (the fork API converts those from what the holding is worth now).
enum SellAmount: Hashable {
    case bps(Int)
    case usd(cents: Int)

    static let all = SellAmount.bps(SaleLimits.all)
}

/// What a sale build is for (the `Prebuilds` key): part or all of your holding on one side of a
/// take (`/takes/:id/sell`), or one whole position (`/positions/:pos/exit`, the only sale a fork
/// API from before partial sales has).
enum SaleKey: Hashable {
    case holding(Side, SellAmount)
    case position(String)
}

/// The partial-sale rules the app checks before asking: what a position keeps after a partial sale
/// has to be at least the program's minimum stake. The fork API checks them again
/// (`remainder_below_minimum`).
enum SaleLimits {
    static let all = 10_000
    /// Mock data's positions keep at least this, like the program's minimum stake.
    static let mockMinimum: Double = 10

    /// The largest partial sale of a position holding `held` (cost basis) that keeps `minimum`, in
    /// bps; nil when it can only be sold all at once.
    static func maxBps(held: Double, minimum: Double) -> Int? {
        guard held > 0 else { return nil }
        let bps = Int(((held - minimum) / held * Double(all)).rounded(.down))
        return bps >= 1 ? min(bps, all - 1) : nil
    }

    /// A holding of several positions (bought more than once): its sale sells whole positions
    /// first, smallest first, then part of one. So the most it can sell short of all is every
    /// position but the largest, plus the largest's own limit. The fork API has the last word.
    static func holdingMaxBps(_ parts: [(held: Double, maxBps: Int?)]) -> Int? {
        if parts.count == 1 { return parts[0].maxBps }
        guard let largest = parts.indices.max(by: { parts[$0].held < parts[$1].held }) else { return nil }
        let total = parts.reduce(0) { $0 + $1.held }
        guard total > 0 else { return nil }
        let rest = total - parts[largest].held
        let fromLargest = parts[largest].held * Double(parts[largest].maxBps ?? 0) / Double(all)
        let bps = Int(((rest + fromLargest) / total * Double(all)).rounded(.down))
        return bps >= 1 ? min(bps, all - 1) : nil
    }

    /// `usd` of a holding worth `value`, the way the fork API converts it: round(usd / value × 10^4)
    /// between 1 and 10,000, and all of it within 0.5% of the full value.
    static func bps(usd: Double, value: Double) -> Int {
        guard value > 0, usd < value * 0.995 else { return all }
        return min(max(Int((usd / value * Double(all)).rounded()), 1), all)
    }
}

/// One side of what you hold in a take, as the Sell tab shows it: on the fork, your positions on
/// that side (from the receipt) as one holding; on mock data, your position.
struct SellHolding: Identifiable, Equatable {
    let side: Side
    /// What you put in, and the part of it you still hold (less what partial sales sold).
    let stakeUsd: Double
    let heldStakeUsd: Double
    /// What the part you hold is worth now (nil while it's pricing).
    let valueUsd: Double?
    /// Gain or loss on what you hold (the fee included on the fork).
    let pnlUsd: Double?
    /// P&L from settled partial sales.
    let realizedPnlUsd: Double?
    let minStakeUsd: Double
    /// The largest partial sale allowed now, in bps of what you hold; nil = only all of it.
    let maxPartialBps: Int?
    /// Selling all of it closes the take: it's the author's own buy-in on an open take.
    let closesTakeIfSoldAll: Bool
    /// The on-chain positions behind it (empty on mock data).
    let addresses: [String]
    /// The fork API sells part of a position (mock data always does).
    let partialSales: Bool
    let canSell: Bool
    /// A partial sale of it waits for its prices.
    let selling: Bool

    var id: Side { side }
    var soldStakeUsd: Double { max(0, stakeUsd - heldStakeUsd) }
}

extension SellHolding {
    /// A mock-data position: it keeps at least `SaleLimits.mockMinimum` after a partial sale.
    init(mock p: OwnedPosition) {
        self.init(side: p.side, stakeUsd: p.amount, heldStakeUsd: p.amount, valueUsd: p.value, pnlUsd: p.pnl,
                  realizedPnlUsd: nil, minStakeUsd: SaleLimits.mockMinimum,
                  maxPartialBps: SaleLimits.maxBps(held: p.amount, minimum: SaleLimits.mockMinimum),
                  closesTakeIfSoldAll: false, addresses: [], partialSales: true, canSell: true, selling: false)
    }

    /// Your positions on one side of a take on the fork. `serverMax` is the fork API's own answer
    /// to a sale that asked for too much (0: only all of it).
    init(fork h: ForkReceipt.MyHolding, minimum: Double, serverMax: Int?, selling: Bool) {
        let side: Side = h.side == "fade" ? .fade : .back
        var limit = h.maxPartialBps
        if let serverMax { limit = serverMax > 0 ? min(serverMax, limit ?? serverMax) : nil }
        self.init(side: side, stakeUsd: h.stakeUsd, heldStakeUsd: h.heldStakeUsd, valueUsd: h.valueUsd, pnlUsd: h.pnl?.usd,
                  realizedPnlUsd: h.realizedPnlUsd, minStakeUsd: h.minStakeUsd ?? minimum, maxPartialBps: limit,
                  closesTakeIfSoldAll: h.closesTakeIfSoldAll, addresses: h.addresses, partialSales: h.partialSales,
                  canSell: h.canExit, selling: selling || h.pendingSales.contains { !$0.priced })
    }
}

/// One of your open holdings as the profile sells it: all of it, after a confirmation.
struct HoldingSale: Hashable, Identifiable {
    let takeID: String
    let claim: String
    let side: Side
    /// What it's worth now (what you put in while it's pricing).
    let worthUsd: Double
    /// The on-chain positions behind it (empty on mock data).
    let addresses: [String]
    /// The fork API sells through `/takes/:id/sell` (false: whole positions, the old way).
    let partialSales: Bool
    /// Your own buy-in on an open take: selling it closes the take.
    let closesTake: Bool

    var id: String { "\(takeID)|\(side.rawValue)" }
    /// "Sell all of your $22.80 position in “AI power demand is underrated”?"
    var question: String {
        let take = claim.hasSuffix(".") ? String(claim.dropLast()) : claim
        return "Sell all of your \(Fmt.usd(worthUsd, cents: true)) position in “\(take)”?"
    }
}

/// Builds for sales made ahead of the tap (see `Prebuilds`), for one take.
extension Prebuilds where Key == SaleKey {
    static func sales(_ app: AppState, takeID: String) -> Prebuilds<SaleKey> {
        Prebuilds(
            build: { key, prebuild in
                switch key {
                case .holding(let side, .bps(let bps)):
                    try await app.prepareSale(takeID: takeID, side: side, bps: bps, prebuild: prebuild)
                case .holding(let side, .usd(let cents)):
                    try await app.prepareSale(takeID: takeID, side: side, usd: Double(cents) / 100, prebuild: prebuild)
                case .position(let address):
                    try await app.prepareExit(takeID: takeID, position: address, prebuild: prebuild)
                }
            },
            refresh: { try await app.refreshPrepared($0) })
    }
}
