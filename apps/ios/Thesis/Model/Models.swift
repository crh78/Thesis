import SwiftUI

struct Person: Identifiable, Hashable {
    /// The handle (without @). Also the avatar asset suffix for mock people.
    let id: String
    let name: String
    let made: Double
    let returnPct: Double
    let takes: Int
    var bio: String = ""
    /// The backend profile id; nil for mock people.
    var remoteID: String? = nil
    /// `asset:<name>` for a bundled image, `face:<name>:<color>` for a built-in
    /// face, an https URL, or nil.
    var avatarURL: String? = nil
    /// Relative to whoever is looking (people lists only).
    var followsYou = false
    /// The second score: what everyone who backed this person's takes made, net of losses
    /// (faders and the person's own positions not counted). From the chain; 0 elsewhere.
    var backersMade: Double = 0
    var backersPct: Double = 0

    /// What follows, saves and comments are keyed by.
    var profileID: String { remoteID ?? id }
    var handle: String { "@\(id)" }
    /// Bundled images only for mock people and explicit `asset:` URLs, so a real
    /// user whose handle matches a demo name doesn't get the demo picture.
    var avatar: String {
        if let avatarURL, avatarURL.hasPrefix("asset:") { return String(avatarURL.dropFirst(6)) }
        if let avatarURL { return avatarURL }
        return remoteID == nil ? "avatar-\(id)" : AvatarFace.defaultValue(for: id)
    }
}

enum Risk: String, CaseIterable, Identifiable, Hashable, Codable {
    case low = "Low", medium = "Medium", high = "High"

    var id: String { rawValue }
    var short: String {
        switch self {
        case .low: "LOW"
        case .medium: "MED"
        case .high: "HIGH"
        }
    }
    var note: String {
        switch self {
        case .low: "Earns interest"
        case .medium: "Plain basket"
        case .high: "Adds leverage"
        }
    }
    var basketNote: String {
        switch self {
        case .low: "Plain basket, plus interest on cash that isn't invested yet."
        case .medium: "Stocks and a prediction. No leverage."
        case .high: "Adds leverage, up to 5x, on picks that support it: more for short takes, less for long ones."
        }
    }
}

enum Horizon: String, CaseIterable, Identifiable, Hashable, Codable {
    case twoWeeks = "2 wks", oneMonth = "1 mo", threeMonths = "3 mo", sixMonths = "6 mo"

    var id: String { rawValue }
    var long: String {
        switch self {
        case .twoWeeks: "2 weeks"
        case .oneMonth: "1 month"
        case .threeMonths: "3 months"
        case .sixMonths: "6 months"
        }
    }

    /// When a take posted at `start` settles: calendar weeks or months, as the server's
    /// `post_take` sets `settles_at`.
    func settleDate(from start: Date = .now, calendar: Calendar = .current) -> Date {
        let (unit, n): (Calendar.Component, Int) = switch self {
        case .twoWeeks: (.weekOfYear, 2)
        case .oneMonth: (.month, 1)
        case .threeMonths: (.month, 3)
        case .sixMonths: (.month, 6)
        }
        return calendar.date(byAdding: unit, value: n, to: start) ?? start
    }
}

struct Leg: Identifiable, Hashable, Codable {
    var id: String { name }
    let name: String
    /// "Stock", "Prediction · Yes", "Stock · 3x" (the leverage the take builder chose), "Earns interest".
    let kind: String
    var weight: Double
    var why: String
    let ret: Double
    /// Categorical color slot; follows the pick, not its rank.
    var slot: Int
    /// What fading this leg does, or nil if it can't be faded.
    let fadeHow: String?
    /// The catalog asset it came from (`securities.id`); nil for picks made before assets.
    var assetID: String? = nil
    /// One company / market whichever issuer ("NVDA"): a basket holds each at most once.
    var assetKey: String? = nil

    var canFade: Bool { fadeHow != nil }
    /// Prediction side for the take builder ("yes" / "no"), nil for everything else.
    var predictionSide: String? {
        guard kind.hasPrefix("Prediction") else { return nil }
        return kind.hasSuffix("No") ? "no" : "yes"
    }

    /// A leveraged pick's leverage, from its kind ("Stock · 3x"); nil for anything else.
    var leverage: Int? {
        guard let match = kind.firstMatch(of: /(\d+)x$/) else { return nil }
        return Int(match.1)
    }
}

/// Something you can put in a basket, as search and the add-a-pick picker show it.
struct Asset: Identifiable, Hashable, Codable {
    let id: String
    /// Same company / market whichever issuer ("NVDA").
    let key: String
    /// "NVDA", "XAU".
    let symbol: String
    /// "NVIDIA".
    let name: String
    /// "Stock", "ETF", "Prediction", "Earns interest", "Stock · 2x".
    let kindLabel: String
    let kind: String
    let venue: String
    let about: String?
    let themes: [String]
    let canShort: Bool
    let apyPct: Double?
    let maxLeverage: Double?
    let expiresAt: Date?
    /// Whether you can buy it where you live.
    let available: Bool
    let priceUSD: Double?
    let change24hPct: Double?

    /// "AMD · Stock" (or the APY for cash, the resolve date for predictions).
    var subtitle: String {
        if let apyPct { return "\(symbol) · Earns \(Fmt.plainPct(apyPct)) a year" }
        if kind == "prediction", let expiresAt { return "Prediction · resolves \(expiresAt.formatted(.dateTime.month(.abbreviated).day()))" }
        return "\(symbol) · \(kindLabel)"
    }

    /// The pick this asset becomes in a basket (same words as the take builder's).
    func leg(weight: Double, slot: Int, why: String? = nil) -> Leg {
        Leg(name: name, kind: kind == "prediction" ? "Prediction · Yes" : kindLabel, weight: weight,
            why: why ?? about ?? "", ret: 0, slot: slot,
            fadeHow: canShort ? (kind == "prediction" ? "Bets No" : "Bets the stock falls") : nil,
            assetID: id, assetKey: key)
    }
}

/// One asset's page: the asset, its live price and its price history.
struct AssetPage: Equatable {
    var asset: Asset
    /// The full description.
    var about: String?
    var issuer: String?
    var fadeHow: String?
    var unavailableNote: String?
    var price: Double?
    var change24hPct: Double?
    /// Price history for the requested range, oldest first.
    var chart: [Double]
    var chartRange: AssetRange
}

enum AssetRange: String, CaseIterable, Identifiable, Hashable {
    case day = "1D", week = "1W", month = "1M", year = "1Y"
    var id: String { rawValue }
}

struct Take: Identifiable, Hashable {
    let id: String
    let author: Person
    let claim: String
    let topic: String
    let risk: Risk
    let horizon: String
    let age: String
    let since: String
    let settles: String
    let ret: Double
    let legs: [Leg]
    // Counts change as people trade, fade and comment.
    var backs: Int
    var fades: Int
    var comments: Int
    var moneyIn: Double
    let history: [Double]
    let tags: [String]
    /// Fork mode: posted, but its on-chain buy-in hasn't confirmed yet. Only its author sees it.
    var posting = false
    /// Where it came from (an article shared into Thesis, an X post), shown as "via …".
    var source: TakeSource? = nil

    var tag: String { "\(risk.short) · \(horizon.uppercased())" }
    var backingShare: Double { Double(backs) / Double(max(1, backs + fades)) }
}

/// Where a take came from: an article shared into Thesis, or an X post (copying an X account).
struct TakeSource: Hashable, Codable {
    let url: URL
    /// "Reuters", "@KobeissiLetter on X".
    let label: String
    /// "link" or "x".
    let kind: String

    var isX: Bool { kind == "x" }
}

enum Position: Hashable {
    case backed(Double), faded(Double), author(Double)

    var label: String {
        switch self {
        case .backed(let v): "Traded \(Fmt.usd(v))"
        case .faded(let v): "Faded \(Fmt.usd(v))"
        case .author(let v): "Author · \(Fmt.usd(v)) in"
        }
    }

    var color: Color {
        switch self {
        case .backed: Palette.up
        case .faded: Palette.down
        case .author: Palette.text
        }
    }

    var isFade: Bool { if case .faded = self { return true } else { return false } }
}

struct Comment: Identifiable, Hashable {
    let id: String
    let author: Person
    /// The commenter's money on the take; nil until paper trading records positions.
    let position: Position?
    let age: String
    let minutesAgo: Int
    var likes: Int
    var text: String
    var replies: [Comment] = []
    /// Whether you liked it.
    var liked = false
}

/// Which score a leaderboard ranks (two scores, no formula).
enum ScoreBoard: String, Hashable {
    /// The account's own P&L.
    case own
    /// What the account's takes made for the people who backed them.
    case backers
    /// What the account made fading other people's takes.
    case faders
}

struct LeaderRow: Identifiable, Hashable {
    var id: String { person.id }
    let person: Person
    let takes: Int
    let cash: Double
    let pct: Double
}

struct ProfileItem: Identifiable, Hashable {
    let id = UUID()
    let topic: String
    let claim: String
    let kind: String
    let kindColor: Color
    let meta: String
    let value: String
    let ret: Double
    /// Set for your live takes, so the row opens the take page.
    var take: Take? = nil
    /// False for rows with no return to show (badges, positions still pricing).
    var showsReturn = true
    /// A picture shown instead of the topic tile (a badge's art).
    var imageURL: URL? = nil
    /// Your positions only: what the share button turns into a called-it card.
    var share: CallCard? = nil
}

/// One inbox notification (supabase/migrations/*_notifications.sql).
struct AppNotification: Identifiable, Hashable, Decodable {
    let id: Int
    /// new_take, comment, take_traded, take_faded, take_settled, badge, daily_positions,
    /// liquidation_risk (a leveraged leg near or close to its liquidation price), x_call (an X
    /// account you copy made a call)
    let kind: String
    let title: String
    let body: String
    let takeId: String?
    let createdAt: Date
    let read: Bool
    /// x_call: the drafted take and the post it came from.
    var data: NotificationData? = nil

    struct NotificationData: Hashable, Decodable {
        let claim: String?
        let risk: String?
        let horizon: String?
        let sourceUrl: String?
        let sourceLabel: String?
        let post: String?
    }

    /// x_call: open the drafted take, basket built, credited to the post.
    var copyLink: TakeLink? {
        guard kind == "x_call", let d = data, let claim = d.claim else { return nil }
        let source = d.sourceUrl.flatMap(URL.init(string:)).map { TakeSource(url: $0, label: d.sourceLabel ?? "X", kind: "x") }
        return TakeLink(claim: claim, risk: d.risk, horizon: d.horizon, source: source)
    }

    /// SF Symbol for the row.
    var symbol: String {
        switch kind {
        case "new_take": "sparkles"
        case "comment": "bubble.left"
        case "take_traded": "arrow.up.right"
        case "take_faded": "arrow.down.right"
        case "take_settled": "flag.checkered"
        case "badge": "rosette"
        case "daily_positions": "chart.line.uptrend.xyaxis"
        case "liquidation_risk": "exclamationmark.triangle"
        case "x_call": "arrow.triangle.branch"
        default: "bell"
        }
    }
}

/// The inbox as the `social` function returns it.
struct Inbox: Decodable {
    let unread: Int
    let notifications: [AppNotification]
}

struct ScoreSeries {
    let points: [Double]
    let labels: [String]
    let pct: Double
    let caption: String
    let rank: String
}

/// One line of your cash activity: a deposit, withdrawal, trade or fade.
struct CashEntry: Identifiable, Hashable {
    enum Kind: String { case deposit, withdrawal, trade, fade, sell }

    let id: String
    let kind: Kind
    /// Signed: + into your balance, − out of it.
    let amount: Double
    let method: FundingMethod?
    let date: Date
    /// For trades and fades.
    let takeClaim: String?
    /// The server's exact timestamp (microseconds), for paging. Nil for mock entries.
    var cursorAt: String? = nil

    var title: String {
        switch kind {
        case .deposit: "Added cash"
        case .withdrawal: "Withdrew"
        case .trade: "Traded"
        case .fade: "Faded"
        case .sell: "Sold"
        }
    }

    var detail: String {
        switch kind {
        case .deposit: method.map { "From \($0.title)" } ?? "Deposit"
        case .withdrawal: method.map { "To \($0.payoutTitle)" } ?? "Withdrawal"
        case .trade, .fade, .sell: takeClaim ?? "A take"
        }
    }

    var systemImage: String {
        switch kind {
        case .deposit: "arrow.down.circle"
        case .withdrawal: "arrow.up.circle"
        case .trade: "arrow.up.right"
        case .fade: "arrow.down.right"
        case .sell: "arrow.uturn.backward"
        }
    }
}

/// A take you've traded or faded: the shares you hold on that side.
///
/// A take's price is 1 + its return ($1.00 when posted). Trading buys shares at
/// it; a fade gains what the take loses. Selling pays you `value` at today's
/// price. The server (migrations/*_positions_and_selling.sql) owns the math;
/// the app mirrors it for mock mode and the Sell sheet's preview.
struct OwnedPosition: Identifiable, Hashable {
    var id: String { take.id + side.rawValue }
    let take: Take
    let side: Side
    /// Dollars in, still held (selling half halves it).
    var amount: Double
    var shares: Double
    /// The take's price now.
    var price: Double
    /// What it's worth at `price`.
    var value: Double
    /// Trades or fades since it opened.
    var count: Int
    var lastAt: Date

    /// What you paid per share, on average.
    var avgPrice: Double { shares > 0 ? amount / shares : 0 }
    /// Gain or loss if you sold it all now.
    var pnl: Double { value - amount }
    /// Your return, in percent.
    var ret: Double { amount > 0 ? (value / amount - 1) * 100 : 0 }

    /// What `shares` bought for `cost` are worth at `price`.
    static func value(side: Side, shares: Double, cost: Double, price: Double) -> Double {
        side == .back ? shares * price : max(0, 2 * cost - shares * price)
    }
}

extension Take {
    /// 1 + its return: $1.00 when posted, $1.14 once it's up 14%.
    var price: Double { 1 + ret / 100 }
}

/// What a sale did: how much it paid and what you made on that part.
struct SaleResult: Equatable {
    let sold: Double
    let pnl: Double
    /// The whole position was sold.
    let closed: Bool
}

/// What a balance read returns: the balance and the newest page of activity.
struct CashSummary {
    let balance: Double
    let activity: [CashEntry]
    /// Older activity exists beyond this page.
    var hasMore = false
}

/// Someone to follow, with why (e.g. "Followed by @priya and 2 others").
struct Suggestion: Identifiable, Hashable {
    let person: Person
    let reason: String
    var id: String { person.profileID }
}

/// Someone who traded or faded a take, and how much (take page, Traders sheet).
struct Trader: Identifiable, Hashable {
    let person: Person
    let side: Side
    let amount: Double
    let isYou: Bool
    var id: String { person.profileID + (side == .back ? ":trade" : ":fade") }
}

/// What the take builder returned for a draft.
struct BuiltBasket {
    var legs: [Leg]
    var summary: String?
    /// Set when nothing tradeable tracks the take closely enough.
    var noExposureReason: String?
    /// Why an edit didn't do what was asked ("NVIDIA isn't available in the US yet.").
    var note: String? = nil
}
