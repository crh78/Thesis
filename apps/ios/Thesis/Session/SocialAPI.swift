import Foundation

/// The social backend: takes, feeds, follows, saves, comments, Scores.
///
/// Public reads call the SQL read functions (`/rest/v1/rpc/<name>`) with the
/// publishable key. Writes, saves and anything that reveals who someone follows
/// (follow lists, the following feed, suggestions, traders) go through the
/// `social` edge function with the Privy access token, so follow privacy holds. See supabase/migrations/*_social*.sql
/// and supabase/functions/social.
struct SocialAPI: Sendable {
    var baseURL: URL = AppConfig.supabaseURL
    var publishableKey: String = AppConfig.supabasePublishableKey
    /// A fresh Privy access token (Privy refreshes it when needed).
    let token: @Sendable () async throws -> String

    // MARK: Reads

    func feed() async throws -> [Take] {
        try await rpc("feed", ["p_limit": 50], as: [TakeDTO].self).map(\.take)
    }

    /// Takes from people you follow.
    func followingFeed() async throws -> [Take] {
        struct Body: Decodable { let takes: [TakeDTO] }
        return try Self.decoder.decode(Body.self, from: try await call("GET", "following-feed")).takes.map(\.take)
    }

    func trending(tag: String?) async throws -> [Take] {
        try await rpc("trending", ["p_tag": tag ?? NSNull()], as: [TakeDTO].self).map(\.take)
    }

    func search(_ query: String, tag: String?) async throws -> [Take] {
        try await rpc("search_takes", ["p_query": query, "p_tag": tag ?? NSNull()], as: [TakeDTO].self).map(\.take)
    }

    func take(id: String) async throws -> Take? {
        try await rpc("take", ["p_id": id], as: TakeDTO?.self)?.take
    }

    func takes(by profileID: String) async throws -> [Take] {
        try await rpc("profile_takes", ["p_profile": profileID], as: [TakeDTO].self).map(\.take)
    }

    func comments(on takeID: String, viewer: String?) async throws -> [Comment] {
        try await rpc("take_comments", ["p_take": takeID, "p_viewer": viewer ?? NSNull()],
                      as: [CommentDTO].self).map(\.comment)
    }

    /// Someone's followers. Throws `.hidden` if they keep it private (yours never are).
    func followers(of profileID: String) async throws -> [Person] {
        try await people("followers/\(profileID)")
    }

    /// Who someone follows. Throws `.hidden` if they keep it private.
    func following(of profileID: String) async throws -> [Person] {
        try await people("following/\(profileID)")
    }

    /// People for you to follow, best first (see `suggested_follows`).
    func suggested(limit: Int = 20) async throws -> [Suggestion] {
        struct Body: Decodable { let people: [PersonDTO] }
        let data = try await call("GET", "suggestions?limit=\(limit)")
        return try Self.decoder.decode(Body.self, from: data).people
            .map { Suggestion(person: $0.person, reason: $0.reason ?? "") }
    }

    private func people(_ path: String) async throws -> [Person] {
        struct Body: Decodable { let people: [PersonDTO] }
        return try Self.decoder.decode(Body.self, from: try await call("GET", path)).people.map(\.person)
    }

    /// Boots `take-builder` ahead of time so building skips the cold start.
    func warmTakeBuilder() async {
        _ = try? await function("take-builder", "GET", "", body: nil)
    }

    /// Builds a basket for a take (`take-builder` function, ~2.5 s warm). `include`: asset ids the
    /// basket must keep (a take started from an asset page).
    func buildBasket(claim: String, risk: Risk, horizon: Horizon, include: [String] = []) async throws -> BuiltBasket {
        var body = Self.builderBody(claim, risk, horizon)
        if !include.isEmpty { body["include"] = include }
        return try await takeBuilder(body)
    }

    /// Changes a basket the way `ask` says ("add AMD", "less crypto"), ~2 s.
    func editBasket(claim: String, risk: Risk, horizon: Horizon, legs: [Leg], ask: String) async throws -> BuiltBasket {
        var body = Self.builderBody(claim, risk, horizon)
        body["mode"] = "edit"
        body["ask"] = ask
        body["legs"] = Self.builderLegs(legs)
        return try await takeBuilder(body)
    }

    /// Same picks at a new risk: only the cash (low) or leveraged (high) pick changes. Instant.
    func adjustBasketRisk(claim: String, risk: Risk, horizon: Horizon, legs: [Leg]) async throws -> BuiltBasket {
        var body = Self.builderBody(claim, risk, horizon)
        body["mode"] = "risk"
        body["legs"] = Self.builderLegs(legs)
        return try await takeBuilder(body)
    }

    private static func builderBody(_ claim: String, _ risk: Risk, _ horizon: Horizon) -> [String: Any] {
        ["claim": claim, "risk": risk.rawValue.lowercased(), "horizon": horizon.long]
    }

    private static func builderLegs(_ legs: [Leg]) -> [[String: Any]] {
        legs.compactMap { leg in
            guard let id = leg.assetID else { return nil }
            var out: [String: Any] = ["id": id, "weight": leg.weight, "why": leg.why]
            if let side = leg.predictionSide { out["side"] = side }
            if let leverage = leg.leverage { out["leverage"] = leverage }
            return out
        }
    }

    private func takeBuilder(_ body: [String: Any]) async throws -> BuiltBasket {
        let data = try await function("take-builder", "POST", "", body: try JSONSerialization.data(withJSONObject: body))
        return try Self.decoder.decode(BuiltBasketDTO.self, from: data).basket
    }

    // MARK: Assets

    /// Tickers and names first ("nvda"), then by meaning ("chip makers"); empty = most traded.
    func searchAssets(_ query: String, limit: Int = 20) async throws -> [Asset] {
        struct Body: Decodable { let assets: [AssetDTO] }
        var q = URLComponents()
        q.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: "\(limit)")]
        let data = try await function("assets", "GET", "search?\(q.percentEncodedQuery ?? "")", body: nil)
        return try Self.decoder.decode(Body.self, from: data).assets.map(\.asset)
    }

    /// One asset's page with its price history for `range`.
    func assetPage(_ id: String, range: AssetRange) async throws -> AssetPage {
        let data = try await function("assets", "GET", "\(id)?range=\(range.rawValue)", body: nil)
        return try Self.decoder.decode(AssetPageDTO.self, from: data).page(range: range)
    }

    /// Takes holding an asset (any issuer of the same company), newest first.
    func assetTakes(_ id: String) async throws -> [Take] {
        try await rpc("asset_takes", ["p_asset": id], as: [TakeDTO].self).map(\.take)
    }

    /// People by handle or name.
    func searchPeople(_ query: String) async throws -> [Person] {
        try await rpc("search_people", ["p_query": query], as: [PersonDTO].self).map(\.person)
    }

    /// Your inbox, newest first, and how many are unread.
    func notifications(limit: Int = 50) async throws -> Inbox {
        try Self.decoder.decode(Inbox.self, from: try await call("GET", "notifications?limit=\(limit)"))
    }

    /// Marks these notifications (or all of them) read; returns what's still unread.
    @discardableResult
    func markNotificationsRead(_ ids: [Int]? = nil) async throws -> Int {
        struct Body: Encodable { let ids: [Int]? }
        struct Unread: Decodable { let unread: Int }
        let data = try await call("POST", "notifications/read", body: try JSONEncoder().encode(Body(ids: ids)))
        return try Self.decoder.decode(Unread.self, from: data).unread
    }

    /// Who traded / faded a take: you first, then people you follow, then recent.
    func traders(of takeID: String) async throws -> [Trader] {
        struct Body: Decodable { let traders: [TraderDTO] }
        return try Self.decoder.decode(Body.self, from: try await call("GET", "traders/\(takeID)")).traders.map(\.trader)
    }

    /// A profile with follower / following counts and whether its lists are public.
    func profileDetail(_ profileID: String) async throws -> ProfileDetail? {
        guard let dto = try await rpc("profile", ["p_profile": profileID], as: PersonDTO?.self) else { return nil }
        return ProfileDetail(person: dto.person, followers: dto.followers ?? 0, following: dto.following ?? 0,
                             privacy: dto.privacy)
    }

    func profile(_ profileID: String) async throws -> Person? {
        try await rpc("profile", ["p_profile": profileID], as: PersonDTO?.self)?.person
    }

    /// `period`: "week", "month" or "all". `board`: "own" (own P&L), "backers" (made for
    /// backers) or "faders" (made from fading). `sort`: "cash" or "pct".
    func leaderboard(_ period: String, board: String, sort: String) async throws -> [LeaderRow] {
        try await rpc("leaderboard", ["p_period": period, "p_board": board, "p_sort": sort], as: [LeaderDTO].self).map(\.row)
    }

    // MARK: Writes (and saves, which are private)

    func saved() async throws -> [Take] {
        struct Saves: Decodable { let takes: [TakeDTO] }
        return try Self.decoder.decode(Saves.self, from: try await call("GET", "saves")).takes.map(\.take)
    }

    func setSaved(_ takeID: String, _ on: Bool) async throws {
        _ = try await call(on ? "PUT" : "DELETE", "saves/\(takeID)")
    }

    func setFollowing(_ profileID: String, _ on: Bool) async throws {
        _ = try await call(on ? "PUT" : "DELETE", "follows/\(profileID)")
    }

    func post(_ take: NewTake) async throws -> Take {
        struct Created: Decodable { let take: TakeDTO }
        let data = try await call("POST", "takes", body: try Self.encoder.encode(take))
        return try Self.decoder.decode(Created.self, from: data).take.take
    }

    /// Your takes still waiting for the chain (nobody else sees them).
    func postingTakes() async throws -> [Take] {
        struct List: Decodable { let takes: [TakeDTO] }
        let data = try await call("GET", "takes/posting")
        return try Self.decoder.decode(List.self, from: data).takes.map(\.take)
    }

    /// Drops your take if it never made it on-chain.
    func discard(_ takeID: String) async throws {
        _ = try await call("DELETE", "takes/\(takeID)")
    }

    /// Returns the take's whole thread, so replies land in the right place.
    func comment(on takeID: String, text: String, replyingTo parentID: String?) async throws -> [Comment] {
        struct Body: Encodable { let takeId: String; let parentId: String?; let body: String }
        struct Thread: Decodable { let comments: [CommentDTO] }
        let data = try await call("POST", "comments",
                                  body: try Self.encoder.encode(Body(takeId: takeID, parentId: parentID, body: text)))
        return try Self.decoder.decode(Thread.self, from: data).comments.map(\.comment)
    }

    func setLiked(_ commentID: String, _ on: Bool) async throws {
        _ = try await call(on ? "PUT" : "DELETE", "comments/\(commentID)/like")
    }

    // MARK: Transport

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = ServerDate.parse(raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(raw)"))
            }
            return date
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    private func rpc<T: Decodable>(_ name: String, _ args: [String: Any], as: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: "rest/v1/rpc/\(name)"))
        request.httpMethod = "POST"
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // Fork builds read takes' counts and results from the fork's chain events
        // (chain_takes, filled by the QuickNode Stream webhook via `pnpm fork:relay`).
        if AppConfig.forkAPIURL != nil { request.setValue("solana-mainnet-fork", forHTTPHeaderField: "x-thesis-network") }
        request.httpBody = try JSONSerialization.data(withJSONObject: args)
        let (data, status) = try await load(request)
        guard status == 200 else { throw SocialAPIError(status: status, data: data) }
        return try Self.decoder.decode(T.self, from: data)
    }

    /// The `social` edge function. `contentType` is for non-JSON bodies (photo uploads).
    func call(_ method: String, _ path: String, body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        try await function("social", method, path, body: body, contentType: contentType)
    }

    /// The `cash` edge function (CashAPI.swift).
    func cashCall(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        try await function("cash", method, path, body: body)
    }

    func function(_ name: String, _ method: String, _ path: String, body: Data?,
                          contentType: String = "application/json") async throws -> Data {
        // `path` may carry an already-encoded query ("activity?before_at=…").
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        let route = parts.first ?? ""
        var components = URLComponents(url: baseURL.appending(path: route.isEmpty ? "functions/v1/\(name)" : "functions/v1/\(name)/\(route)"),
                                       resolvingAgainstBaseURL: false)!
        if parts.count > 1 { components.percentEncodedQuery = parts[1] }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue(try await token(), forHTTPHeaderField: "privy-token")
        if AppConfig.forkAPIURL != nil { request.setValue("solana-mainnet-fork", forHTTPHeaderField: "x-thesis-network") }
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let (data, status) = try await load(request)
        guard (200..<300).contains(status) else { throw SocialAPIError(status: status, data: data) }
        return data
    }

    private func load(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? -1)
        } catch let error as URLError where error.code != .cancelled {
            throw SocialAPIError.offline
        }
    }
}

/// A take to post. Encoded snake_case for the `social` function.
struct NewTake: Encodable {
    struct NewLeg: Encodable {
        let name: String
        let kind: String
        let weight: Double
        let why: String
        let slot: Int
        let fadeHow: String?
        let assetId: String?
    }

    let claim: String
    let topic: String
    let risk: String
    let horizon: String
    let tags: [String]
    let legs: [NewLeg]
    /// Fork mode: keep the take hidden from everyone else until its on-chain buy-in confirms.
    let awaitChain: Bool

    init(draft: TakeDraft, legs: [Leg], awaitChain: Bool = false) {
        self.awaitChain = awaitChain
        let claim = draft.claim.trimmingCharacters(in: .whitespacesAndNewlines)
        let guess = TopicGuess(claim: claim, legs: legs)
        self.claim = claim
        self.topic = guess.topic
        self.tags = guess.tags
        self.risk = draft.risk.serverValue
        self.horizon = draft.horizon.serverValue
        self.legs = legs.map {
            NewLeg(name: $0.name, kind: $0.kind, weight: $0.weight, why: $0.why, slot: $0.slot, fadeHow: $0.fadeHow,
                   assetId: $0.assetID)
        }
    }
}

enum SocialAPIError: LocalizedError, Equatable {
    case offline
    case signedOut
    case needsOnboarding
    case notFound
    /// Someone's follow list that they keep private.
    case hidden
    case handleTaken
    case invalid(String)
    case server(Int)

    init(status: Int, data: Data) {
        struct Failure: Decodable { let error: String?; let message: String? }
        let failure = try? JSONDecoder().decode(Failure.self, from: data)
        switch status {
        case 401: self = .signedOut
        case 403 where failure?.error == "needs_onboarding": self = .needsOnboarding
        case 403 where failure?.error == "hidden": self = .hidden
        case 404: self = .notFound
        case 409 where failure?.error == "handle_taken": self = .handleTaken
        case 400: self = .invalid(failure?.error ?? failure?.message ?? "invalid")
        default: self = .server(status)
        }
    }

    var errorDescription: String? {
        switch self {
        case .offline: "You're offline. Check your connection and try again."
        case .signedOut: "Your session ended. Sign in again."
        case .needsOnboarding: "Finish setting up your profile first."
        case .notFound: "That's not there anymore."
        case .hidden: "They keep this private."
        case .handleTaken: "That handle is taken."
        case .invalid: "Something in there doesn't look right."
        case .server: "Something went wrong on our end. Try again."
        }
    }
}

// MARK: - Server shapes

struct BuiltBasketDTO: Decodable {
    let verdict: String
    let summary: String?
    let reason: String?
    let legs: [BuiltLegDTO]
    let note: String?

    var basket: BuiltBasket {
        BuiltBasket(legs: legs.enumerated().map { $1.leg(slot: $0) },
                    summary: summary,
                    noExposureReason: verdict == "no_clean_exposure" ? (reason ?? "Nothing you can buy tracks this closely enough yet.") : nil,
                    note: note)
    }
}

struct BuiltLegDTO: Decodable {
    let id: String
    let key: String?
    let name: String
    let kind: String
    let role: String
    let weight: Double
    let why: String
    let canShort: Bool
    let side: String?
    /// 1, or for a perp the leverage the take builder chose (at most 5x).
    let leverage: Int?

    func leg(slot: Int) -> Leg {
        let label = switch kind {
        case "etf": "ETF"
        case "commodity": "Commodity"
        case "pre-ipo": "Pre-IPO"
        // No default leverage: without the builder's number the leg says
        // "Leveraged", and the fork leaves it out rather than guess.
        // "Perp", not "Stock": perps cover crypto too (SOL). The fork API reads only the "3x".
        case "perp": leverage.map { "Perp · \($0)x" } ?? "Leveraged"
        case "leveraged": "Leveraged"
        case "yield": "Earns interest"
        case "prediction": side == "no" ? "Prediction · No" : "Prediction · Yes"
        case "card": "Cards"
        default: "Stock"
        }
        // Yield vaults have crypto names ("Plume x Re7 USDC"); to the user it's just cash earning interest.
        let shown = kind == "yield" ? "Cash" : Self.displayName(name)
        return Leg(name: shown, kind: label, weight: weight, why: why, ret: 0, slot: slot,
                   fadeHow: canShort ? (kind == "prediction" ? "Bets No" : kind == "perp" ? "Bets it falls" : "Bets the stock falls") : nil,
                   assetID: id, assetKey: key ?? id)
    }

    /// "NVIDIA xStock" → "NVIDIA"; "Bloom Energy - Backpack Securities" → "Bloom Energy";
    /// "Krispy Kreme, Inc. Common Stock" → "Krispy Kreme"; "Apple (Ondo Tokenized)" → "Apple".
    static func displayName(_ raw: String) -> String {
        raw.replacingOccurrences(of: #"\s+-\s+Backpack Securities$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #",?\s+(Inc\.|Corporation|Corp\.|N\.V\.|Limited|Ltd\.)(\s+Common Stock)?$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+(PreStocks|Common Stock)$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+(xStock|Tokenized Stock|Tokenized|rStock)\b.*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s*\((Ondo|Backpack|Tokenized)[^)]*\)$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}

struct TraderDTO: Decodable {
    let person: PersonDTO
    let side: String
    let amount: Double
    let isYou: Bool

    var trader: Trader {
        Trader(person: person.person, side: side == "fade" ? .fade : .back, amount: amount, isYou: isYou)
    }
}

struct PersonDTO: Decodable {
    let id: String
    let handle: String?
    let displayName: String?
    let bio: String?
    let avatarUrl: String?
    let made: Double
    let returnPct: Double
    let backersMade: Double?
    let backersPct: Double?
    let takes: Int
    let followsYou: Bool?
    /// Only on suggestions.
    let reason: String?
    /// Only on `profile`.
    let followers: Int?
    let following: Int?
    let showFollowers: Bool?
    let showFollowing: Bool?

    var privacy: FollowPrivacy {
        FollowPrivacy(showFollowing: showFollowing ?? true, showFollowers: showFollowers ?? true)
    }

    var person: Person {
        Person(id: handle ?? String(id.prefix(8)),
               name: displayName ?? handle ?? "Someone",
               made: made, returnPct: returnPct, takes: takes,
               bio: bio ?? "", remoteID: id, avatarURL: avatarUrl,
               followsYou: followsYou ?? false,
               backersMade: backersMade ?? 0, backersPct: backersPct ?? 0)
    }
}

struct LegDTO: Decodable {
    let name: String
    let kind: String
    let weight: Double
    let why: String
    let slot: Int
    let fadeHow: String?
    let ret: Double
    let assetId: String?

    var leg: Leg {
        Leg(name: name, kind: kind, weight: weight, why: why, ret: ret, slot: slot, fadeHow: fadeHow, assetID: assetId)
    }
}

struct AssetDTO: Decodable {
    let id: String
    let key: String
    let symbol: String
    let name: String
    let kind: String
    let kindLabel: String
    let venue: String
    let about: String?
    let themes: [String]?
    let canShort: Bool
    let apyPct: Double?
    let maxLeverage: Double?
    let expiresAt: Date?
    let available: Bool
    let priceUsd: Double?
    let change24hPct: Double?

    var asset: Asset {
        Asset(id: id, key: key, symbol: symbol, name: name, kindLabel: kindLabel, kind: kind, venue: venue, about: about,
              themes: themes ?? [], canShort: canShort, apyPct: apyPct, maxLeverage: maxLeverage, expiresAt: expiresAt,
              available: available, priceUSD: priceUsd, change24hPct: change24hPct)
    }
}

struct AssetPageDTO: Decodable {
    struct Detail: Decodable {
        let about: String?
        let issuer: String?
        let fadeHow: String?
        let unavailableNote: String?
    }
    struct Price: Decodable { let usd: Double; let change24hPct: Double? }
    struct Chart: Decodable { let points: [[Double]] }

    let asset: AssetDTO
    let detail: Detail
    let price: Price?
    let chart: Chart?

    enum CodingKeys: String, CodingKey { case asset, price, chart }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        asset = try c.decode(AssetDTO.self, forKey: .asset)
        detail = try c.decode(Detail.self, forKey: .asset) // the page's extra fields sit on the asset
        price = try c.decodeIfPresent(Price.self, forKey: .price)
        chart = try c.decodeIfPresent(Chart.self, forKey: .chart)
    }

    func page(range: AssetRange) -> AssetPage {
        AssetPage(asset: asset.asset, about: detail.about, issuer: detail.issuer, fadeHow: detail.fadeHow,
                  unavailableNote: detail.unavailableNote, price: price?.usd ?? asset.priceUsd,
                  change24hPct: price?.change24hPct ?? asset.change24hPct,
                  chart: (chart?.points ?? []).compactMap { $0.count > 1 ? $0[1] : nil }, chartRange: range)
    }
}

struct TakeDTO: Decodable {
    let id: String
    let claim: String
    let topic: String
    let risk: String
    let horizon: String
    let tags: [String]
    let createdAt: Date
    let settlesAt: Date
    let author: PersonDTO
    let legs: [LegDTO]
    let ret: Double
    let history: [Double]
    let backs: Int
    let fades: Int
    let moneyIn: Double
    let comments: Int
    /// "posting" until the on-chain buy-in confirms; missing on older backends (live).
    let status: String?
    /// Where it came from (an article or an X post); missing on older backends.
    let source: TakeSource?

    var take: Take {
        Take(id: id, author: author.person, claim: claim, topic: topic,
             risk: Risk(serverValue: risk), horizon: horizon,
             age: RelativeAge.short(since: createdAt),
             since: createdAt.formatted(.dateTime.month(.abbreviated).day()),
             settles: settlesAt.formatted(.dateTime.month(.abbreviated).day()),
             ret: ret, legs: legs.map(\.leg), backs: backs, fades: fades, comments: comments,
             moneyIn: moneyIn, history: history.count > 1 ? history : [0, 0], tags: tags,
             posting: status == "posting", source: source)
    }
}

private struct CommentDTO: Decodable {
    let id: String
    let author: PersonDTO
    let body: String
    let createdAt: Date
    let likes: Int
    let liked: Bool
    let replies: [CommentDTO]?

    var comment: Comment {
        Comment(id: id, author: author.person, position: nil,
                age: RelativeAge.short(since: createdAt),
                minutesAgo: max(0, Int(-createdAt.timeIntervalSinceNow / 60)),
                likes: likes, text: body,
                replies: (replies ?? []).map(\.comment), liked: liked)
    }
}

private struct LeaderDTO: Decodable {
    let person: PersonDTO
    let cash: Double
    let pct: Double

    var row: LeaderRow {
        let p = person.person
        return LeaderRow(person: p, takes: p.takes, cash: cash, pct: pct)
    }
}

// MARK: - Helpers

extension Risk {
    var serverValue: String { rawValue.lowercased() }

    init(serverValue: String) {
        switch serverValue {
        case "low": self = .low
        case "high": self = .high
        default: self = .medium
        }
    }
}

extension Horizon {
    var serverValue: String {
        switch self {
        case .twoWeeks: "2wk"
        case .oneMonth: "1mo"
        case .threeMonths: "3mo"
        case .sixMonths: "6mo"
        }
    }
}

/// "now", "5m", "2h", "3d", then a date.
enum RelativeAge {
    static func short(since date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3600))h"
        case ..<(86_400 * 7): return "\(Int(seconds / 86_400))d"
        default: return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }
}

/// Postgres JSON timestamps, e.g. "2026-12-04T23:52:40.734785+00:00".
enum ServerDate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        // ISO8601DateFormatter wants at most milliseconds: trim microseconds.
        let trimmed = raw.replacing(/(\.\d{3})\d+/) { $0.output.1 }
        return withFraction.date(from: trimmed) ?? plain.date(from: trimmed)
    }
}

/// Picks a topic tile and tags for a new take from its words. The AI basket
/// builder can replace this once it returns a topic.
struct TopicGuess {
    let topic: String
    let tags: [String]

    private static let rules: [(words: [String], topic: String, tag: String)] = [
        (["nuclear", "reactor", "uranium"], "topic-nuclear", "Energy"),
        (["power", "energy", "oil", "gas", "grid", "solar", "utility", "utilities"], "topic-energy", "Energy"),
        (["fed", "rate", "rates", "inflation", "treasury", "bond", "cpi"], "topic-bank", "Rates"),
        (["mortgage", "housing", "home", "homes", "rent"], "topic-house", "Housing"),
        (["chip", "chips", "semis", "semiconductor", "nvidia", "amd", "tsmc"], "topic-rocket", "Chips"),
        (["ai", "data-center", "datacenter", "compute", "gpu", "openai"], "topic-computer", "AI"),
        (["stream", "streaming", "netflix", "tv", "cable"], "topic-tv", "Media"),
    ]

    init(claim: String, legs: [Leg]) {
        let text = ([claim] + legs.map(\.name)).joined(separator: " ").lowercased()
        let words = Set(text.split { !$0.isLetter && $0 != "-" }.map(String.init))
        let matches = Self.rules.filter { rule in rule.words.contains { words.contains($0) } }
        topic = matches.first?.topic ?? "topic-coin"
        var seen = Set<String>()
        tags = matches.map(\.tag).filter { seen.insert($0).inserted }.prefix(3).map { $0 }
    }
}
