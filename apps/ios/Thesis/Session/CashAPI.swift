import Foundation

/// Balance, deposits, withdrawals, trades / fades and sells: the `cash` edge
/// function (supabase/functions/cash). All private, so everything needs the
/// Privy token. The money rules live in SQL (migrations/*_cash.sql).
extension SocialAPI {
    func cash() async throws -> CashSummary {
        try Self.decoder.decode(CashSummaryDTO.self, from: try await cashCall("GET", "")).summary
    }

    /// Every take you hold shares in, latest first, valued at today's price.
    func positions() async throws -> [OwnedPosition] {
        struct Row: Decodable {
            let take: TakeDTO
            let side: String
            let amount: Double
            let shares: Double
            let price: Double
            let value: Double
            let count: Int
            let lastAt: Date
        }
        struct Result: Decodable { let positions: [Row] }
        let rows = try Self.decoder.decode(Result.self, from: try await cashCall("GET", "positions")).positions
        return rows.map {
            OwnedPosition(take: $0.take.take, side: $0.side == "fade" ? .fade : .back, amount: $0.amount,
                          shares: $0.shares, price: $0.price, value: $0.value, count: $0.count, lastAt: $0.lastAt)
        }
    }

    /// Sells `amount` dollars of a position at today's price, or all of it when nil.
    func sell(_ takeID: String, side: Side, amount: Double?) async throws -> (CashSummary, SaleResult) {
        struct Body: Encodable { let takeId: String; let side: String; let amount: Double? }
        struct Result: Decodable { let cash: CashSummaryDTO; let sold: Double; let pnl: Double; let closed: Bool }
        let cents = amount.map { ($0 * 100).rounded() / 100 }
        let data = try await cashCall("POST", "sells",
                                      body: try Self.encoder.encode(Body(takeId: takeID, side: side.serverValue, amount: cents)))
        let r = try Self.decoder.decode(Result.self, from: data)
        return (r.cash.summary, SaleResult(sold: r.sold, pnl: r.pnl, closed: r.closed))
    }

    /// The page of activity after `last` (the oldest entry you have).
    func activity(after last: CashEntry) async throws -> (entries: [CashEntry], hasMore: Bool) {
        guard let cursor = last.cursorAt else { return ([], false) }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "before_at", value: cursor), URLQueryItem(name: "before_id", value: last.id)]
        // "+" in the timezone must be escaped or the server reads it as a space.
        let encoded = (query.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let page = try Self.decoder.decode(CashPageDTO.self, from: try await cashCall("GET", "activity?\(encoded)"))
        return (page.activity.compactMap(\.entry), page.hasMore)
    }

    func deposit(_ amount: Double, method: FundingMethod) async throws -> CashSummary {
        try await move("deposits", amount: amount, method: method)
    }

    func withdraw(_ amount: Double, method: FundingMethod) async throws -> CashSummary {
        try await move("withdrawals", amount: amount, method: method)
    }

    /// Trades or fades a take for `amount` dollars (from $1, up to your balance).
    /// Returns your cash and the take with its updated counts.
    func trade(_ takeID: String, side: Side, amount: Double) async throws -> (CashSummary, Take) {
        struct Body: Encodable { let takeId: String; let side: String; let amount: Double }
        struct Result: Decodable { let cash: CashSummaryDTO; let take: TakeDTO }
        let cents = (amount * 100).rounded() / 100
        let data = try await cashCall("POST", "trades",
                                      body: try Self.encoder.encode(Body(takeId: takeID, side: side.serverValue, amount: cents)))
        let result = try Self.decoder.decode(Result.self, from: data)
        return (result.cash.summary, result.take.take)
    }

    private func move(_ path: String, amount: Double, method: FundingMethod) async throws -> CashSummary {
        struct Body: Encodable { let amount: Double; let method: String }
        // Send whole cents so 0.1 + 0.2 style floats never reach the server.
        let cents = (amount * 100).rounded() / 100
        let data = try await cashCall("POST", path, body: try Self.encoder.encode(Body(amount: cents, method: method.serverValue)))
        return try Self.decoder.decode(CashSummaryDTO.self, from: data).summary
    }
}

extension Side {
    /// `.back` is the code name; the server (and users) call it a trade.
    var serverValue: String { self == .back ? "trade" : "fade" }
}

/// What a cash error means to the person looking at it.
enum CashErrorText {
    static func message(for error: Error) -> String {
        switch error as? SocialAPIError {
        case .invalid("insufficient_funds"): "Not enough cash in your balance."
        case .invalid("over_daily_limit"): "You can add up to $2,500 a day for now."
        case .invalid("below_minimum"): "That's under the minimum."
        case .invalid("no_position"): "You don't hold this anymore."
        case .invalid("not_tradeable"): "This take can't be traded right now."
        case .some(let e): e.errorDescription ?? "That didn't go through. Try again."
        case nil: "That didn't go through. Try again."
        }
    }
}

// MARK: - Server shapes

struct CashSummaryDTO: Decodable {
    let balance: Double
    let activity: [CashEntryDTO]
    let hasMore: Bool?

    var summary: CashSummary {
        CashSummary(balance: balance, activity: activity.compactMap(\.entry), hasMore: hasMore ?? false)
    }
}

struct CashPageDTO: Decodable {
    let activity: [CashEntryDTO]
    let hasMore: Bool
}

struct CashEntryDTO: Decodable {
    let id: String
    let kind: String
    let amount: Double
    let method: String?
    /// Kept as text: it's the paging cursor and Date would drop the microseconds.
    let createdAt: String
    let takeClaim: String?

    var entry: CashEntry? {
        guard let kind = CashEntry.Kind(rawValue: kind), let date = ServerDate.parse(createdAt) else { return nil }
        return CashEntry(id: id, kind: kind, amount: amount, method: FundingMethod(serverValue: method),
                         date: date, takeClaim: takeClaim, cursorAt: createdAt)
    }
}
