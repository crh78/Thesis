import Foundation

/// Editing a basket by hand: add, remove and reweight picks so the weights always add up to 100.
enum BasketMath {
    /// The most picks a take can hold (the program's limit).
    static let maxPicks = 10

    /// Whole percents that add up to exactly 100, in the same proportions (each at least 1).
    static func normalized(_ legs: [Leg]) -> [Leg] {
        guard !legs.isEmpty else { return [] }
        let total = legs.reduce(0) { $0 + max($1.weight, 0) }
        var out = legs
        var assigned = 0.0
        for i in out.indices {
            let share = total > 0 ? max(out[i].weight, 0) / total * 100 : 100 / Double(out.count)
            let w = i == out.count - 1 ? 100 - assigned : max(1, share.rounded())
            out[i].weight = w
            assigned += w
        }
        // Rounding up the small ones can push the last below 1: take it from the biggest.
        if let last = out.indices.last, out[last].weight < 1, let big = out.indices.max(by: { out[$0].weight < out[$1].weight }) {
            out[big].weight -= 1 - out[last].weight
            out[last].weight = 1
        }
        return out
    }

    /// Whether the basket already holds this company / market (any issuer).
    static func contains(_ asset: Asset, in legs: [Leg]) -> Bool {
        legs.contains { $0.assetKey == asset.key || $0.assetID == asset.id || $0.name == asset.name }
    }

    /// Adds an asset at an even share; the others shrink in proportion.
    static func adding(_ asset: Asset, to legs: [Leg]) -> [Leg] {
        guard !contains(asset, in: legs), legs.count < maxPicks else { return legs }
        let share = 100 / Double(legs.count + 1)
        let scaled = legs.map { leg -> Leg in
            var l = leg
            l.weight = leg.weight * (1 - share / 100)
            return l
        }
        return normalized(scaled + [asset.leg(weight: share, slot: nextSlot(legs))])
    }

    /// Removes a pick; the rest grow back to 100 in proportion. Never empties the basket.
    static func removing(_ leg: Leg, from legs: [Leg]) -> [Leg] {
        let rest = legs.filter { $0.id != leg.id }
        return rest.isEmpty ? legs : normalized(rest)
    }

    /// Sets one pick's weight; the others share what's left in proportion.
    static func setting(_ leg: Leg, to weight: Double, in legs: [Leg]) -> [Leg] {
        guard legs.count > 1 else { return legs }
        let w = min(max(weight.rounded(), 1), 100 - Double(legs.count - 1))
        let others = legs.filter { $0.id != leg.id }
        let othersTotal = others.reduce(0) { $0 + $1.weight }
        var out = legs.map { l -> Leg in
            var x = l
            x.weight = l.id == leg.id ? w : (othersTotal > 0 ? l.weight / othersTotal : 1 / Double(others.count)) * (100 - w)
            return x
        }
        // Keep the one you set exact: rounding goes to the others.
        let fixed = out.firstIndex { $0.id == leg.id }!
        out = normalized(out)
        let drift = out[fixed].weight - w
        if drift != 0, let other = out.indices.filter({ $0 != fixed }).max(by: { out[$0].weight < out[$1].weight }) {
            out[fixed].weight = w
            out[other].weight += drift
        }
        return out
    }

    /// The first color slot no pick uses yet, so a new pick gets its own color.
    static func nextSlot(_ legs: [Leg]) -> Int {
        let used = Set(legs.map(\.slot))
        return (0..<maxPicks).first { !used.contains($0) } ?? legs.count % maxPicks
    }
}
