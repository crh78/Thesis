import SwiftUI

/// Sample data that mirrors the mockups. Replace with the real API later.
enum MockData {
    // MARK: People

    static let jake = Person(id: "jake", name: "Jake", made: 2410, returnPct: 31.4, takes: 6,
                             bio: "Power, compute, the grid. Long the boring stuff.")
    static let priya = Person(id: "priya", name: "Priya", made: 4120, returnPct: 38.1, takes: 9,
                              bio: "Rates and macro. I read the Fed minutes so you don't have to.")
    static let dev = Person(id: "dev", name: "Dev", made: -310, returnPct: -4.8, takes: 5,
                            bio: "Semis maximalist. Occasionally right.")
    static let lena = Person(id: "lena", name: "Lena", made: 1980, returnPct: 27.9, takes: 11,
                             bio: "Housing, consumer, anything with a receipt.")
    static let mo = Person(id: "mo", name: "Mo", made: 1455, returnPct: 44.2, takes: 4,
                           bio: "Professional fader. Nothing personal.")
    static let kai = Person(id: "kai", name: "Kai", made: 320, returnPct: 61.0, takes: 3,
                            bio: "Small bets, big conviction.")
    static let me = Person(id: "sarah", name: "Sarah", made: 1284.5, returnPct: 22.6, takes: 33,
                           bio: "Mostly energy and rates. Fade me if you dare.")

    static let everyone = [jake, priya, dev, lena, mo, kai]
    static let followers = [jake, priya, dev, lena, mo, kai]
    static let followingBase = [jake, priya, lena, mo]

    static let balance: Double = 182.40

    // MARK: Legs

    static let vistra = Leg(name: "Vistra", kind: "Stock", weight: 30,
        why: "Power producer with nuclear and gas plants. Earns more as electricity demand climbs.",
        ret: 18.0, slot: 0, fadeHow: nil, assetID: "mock:VST", assetKey: "VST")
    static let constellation = Leg(name: "Constellation", kind: "Stock", weight: 25,
        why: "Largest US nuclear fleet, with power deals signed with big tech.",
        ret: 12.4, slot: 1, fadeHow: "Bets the stock falls", assetID: "mock:CEG", assetKey: "CEG")
    static let nvidia = Leg(name: "NVIDIA", kind: "Stock", weight: 25,
        why: "Its chips drive the data-center build-out behind the demand.",
        ret: 9.6, slot: 2, fadeHow: "Bets the stock falls", assetID: "mock:NVDA", assetKey: "NVDA")
    static let capex = Leg(name: "Data-center spending", kind: "Prediction · Yes", weight: 20,
        why: "Pays out if big-tech data-center spending clears [threshold] by [date].",
        ret: 15.5, slot: 3, fadeHow: "Bets No", assetID: "mock:DCCAPEX", assetKey: "mock:DCCAPEX")

    /// The AI-power basket at each risk level (from the Basket mockup).
    static func basket(for risk: Risk) -> [Leg] {
        func w(_ leg: Leg, _ weight: Double) -> Leg {
            var l = leg
            l.weight = weight
            return l
        }
        switch risk {
        case .low:
            return [w(vistra, 25), w(constellation, 25), w(nvidia, 20), w(capex, 10),
                    Leg(name: "Cash", kind: "Earns interest", weight: 20,
                        why: "Money that isn't invested yet earns interest while the take runs.",
                        ret: 1.1, slot: 4, fadeHow: nil, assetID: "mock:CASH", assetKey: "mock:CASH")]
        case .medium:
            return [vistra, constellation, nvidia, capex]
        case .high:
            return [w(vistra, 25), w(constellation, 20),
                    Leg(name: "NVIDIA 2x", kind: "Stock · 2x", weight: 35,
                        why: "Same chip bet at 2x. Gains and losses move twice as fast.",
                        ret: 19.2, slot: 2, fadeHow: "Bets the stock falls"),
                    w(capex, 20)]
        }
    }

    // MARK: Takes

    static let aiPower = Take(
        id: "ai-power", author: jake, claim: "AI power demand is underrated.", topic: "topic-energy",
        risk: .medium, horizon: "3mo", age: "2h", since: "Jan 4", settles: "Apr 4", ret: 14.0,
        legs: [vistra, constellation, nvidia, capex], backs: 24, fades: 7, comments: 12, moneyIn: 1240,
        history: [0, -1.2, 0.8, 2.1, 1.4, 3.9, 5.2, 4.4, 7.0, 8.8, 8.1, 10.2, 11.5, 11.0, 12.6, 13.3, 14.0],
        tags: ["AI", "Energy"])

    static let fedCut = Take(
        id: "fed-jan", author: priya, claim: "The Fed cuts in January.", topic: "topic-bank",
        risk: .low, horizon: "2mo", age: "5h", since: "Jan 1", settles: "Mar 1", ret: 3.1,
        legs: [
            Leg(name: "Rate cut: Yes", kind: "Prediction · Yes", weight: 50, why: "Pays out if the Fed cuts at the January meeting.", ret: 5.2, slot: 0, fadeHow: "Bets No"),
            Leg(name: "T-bills", kind: "Bond fund", weight: 30, why: "Short-term government debt that gains when rates fall.", ret: 1.4, slot: 1, fadeHow: nil),
            Leg(name: "Cash", kind: "Earns interest", weight: 20, why: "Idle cash earns interest while the take runs.", ret: 0.6, slot: 2, fadeHow: nil)
        ],
        backs: 41, fades: 12, comments: 28, moneyIn: 3880,
        history: [0, 0.4, 0.2, 0.9, 1.1, 0.8, 1.6, 2.0, 1.8, 2.4, 2.9, 3.1],
        tags: ["Rates"])

    static let chips = Take(
        id: "chips", author: dev, claim: "Chip stocks lead the next leg up.", topic: "topic-rocket",
        risk: .high, horizon: "1mo", age: "1d", since: "Jan 3", settles: "Feb 3", ret: -4.8,
        legs: [
            Leg(name: "NVIDIA 2x", kind: "Stock · 2x", weight: 40, why: "Leveraged exposure to the biggest AI chip maker.", ret: -7.9, slot: 0, fadeHow: "Bets the stock falls"),
            Leg(name: "AMD", kind: "Stock", weight: 30, why: "Second-source GPUs and server CPUs.", ret: -3.1, slot: 1, fadeHow: "Bets the stock falls"),
            Leg(name: "TSMC", kind: "Stock", weight: 30, why: "Manufactures most of the world's advanced chips.", ret: -2.4, slot: 2, fadeHow: nil)
        ],
        backs: 9, fades: 15, comments: 19, moneyIn: 760,
        history: [0, 1.2, 2.5, 1.8, 0.4, -1.1, -0.6, -2.4, -3.1, -2.2, -4.0, -4.8],
        tags: ["Chips", "AI"])

    static let nuclear = Take(
        id: "nuclear", author: mo, claim: "Nuclear restarts get fast-tracked.", topic: "topic-nuclear",
        risk: .medium, horizon: "6mo", age: "8h", since: "Dec 28", settles: "Jun 28", ret: 9.4,
        legs: [
            Leg(name: "Constellation", kind: "Stock", weight: 40, why: "Owns the reactors most likely to restart.", ret: 11.2, slot: 0, fadeHow: "Bets the stock falls"),
            Leg(name: "Vistra", kind: "Stock", weight: 30, why: "Nuclear-heavy power producer.", ret: 9.0, slot: 1, fadeHow: nil),
            Leg(name: "Restart approved: Yes", kind: "Prediction · Yes", weight: 30, why: "Pays out if a shut reactor gets a restart approval by [date].", ret: 7.4, slot: 2, fadeHow: "Bets No")
        ],
        backs: 33, fades: 6, comments: 14, moneyIn: 2210,
        history: [0, 0.6, 1.4, 1.1, 2.9, 4.0, 5.2, 6.1, 7.8, 9.4],
        tags: ["Energy"])

    static let mortgage = Take(
        id: "mortgage", author: lena, claim: "Mortgage rates dip under 6% by spring.", topic: "topic-house",
        risk: .low, horizon: "6mo", age: "1d", since: "Dec 30", settles: "Jun 30", ret: 2.2,
        legs: [
            Leg(name: "Rates under 6%: Yes", kind: "Prediction · Yes", weight: 50, why: "Pays out if the 30-year average drops under 6%.", ret: 3.4, slot: 0, fadeHow: "Bets No"),
            Leg(name: "Homebuilders", kind: "Stock basket", weight: 30, why: "Builders sell more homes when rates fall.", ret: 1.8, slot: 1, fadeHow: nil),
            Leg(name: "Cash", kind: "Earns interest", weight: 20, why: "Idle cash earns interest while the take runs.", ret: 0.6, slot: 2, fadeHow: nil)
        ],
        backs: 18, fades: 9, comments: 7, moneyIn: 980,
        history: [0, 0.3, 0.1, 0.8, 1.2, 1.0, 1.7, 2.2],
        tags: ["Housing", "Rates"])

    static let dataCenterSlows = Take(
        id: "dc-slows", author: kai, claim: "Data-center spending slows in 2027.", topic: "topic-computer",
        risk: .high, horizon: "3mo", age: "2d", since: "Jan 2", settles: "Apr 2", ret: -1.9,
        legs: [
            Leg(name: "DC spending: No", kind: "Prediction · No", weight: 60, why: "Pays out if big-tech capex misses [threshold].", ret: -3.0, slot: 0, fadeHow: "Bets Yes"),
            Leg(name: "Utilities", kind: "Stock basket", weight: 40, why: "Defensive if the build-out cools.", ret: -0.3, slot: 1, fadeHow: nil)
        ],
        backs: 5, fades: 11, comments: 6, moneyIn: 410,
        history: [0, 0.5, -0.4, -0.2, -1.1, -0.8, -1.9],
        tags: ["AI"])

    static let feed = [aiPower, fedCut, chips, dataCenterSlows]
    /// Takes from people you follow.
    static let followingFeed = [nuclear, mortgage, aiPower, fedCut]
    static let trending = [aiPower, nuclear, fedCut, mortgage, dataCenterSlows, chips]
    static let allTakes = trending
    static let topics = ["All", "AI", "Energy", "Rates", "Chips", "Housing"]
    static let topCallers = [priya, jake, lena, mo, kai]

    // MARK: Take chart ranges

    static let takeRanges = ["1D", "1W", "All"]

    static func series(for take: Take, range: String) -> (values: [Double], labels: [String], caption: String) {
        if take.id == aiPower.id {
            switch range {
            case "1D":
                return ([13.1, 13.3, 13.0, 13.4, 13.6, 13.5, 13.8, 13.7, 14.0, 13.9, 14.0],
                        ["9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM"], "today")
            case "1W":
                let v = [11.2, 11.8, 11.5, 12.4, 12.1, 12.9, 13.3, 13.0, 13.6, 14.0]
                return (v, v.indices.map { "Jan \(11 + Int((Double($0) * 7 / 9).rounded()))" }, "past week")
            default:
                let v = take.history
                return (v, v.indices.map { "Jan \(4 + Int((Double($0) * 14 / 16).rounded()))" }, "since posted")
            }
        }
        let h = take.history
        switch range {
        case "1D":
            let end = h.last ?? 0
            let v = (0..<11).map { end - 0.6 + Double($0) * 0.06 + sin(Double($0)) * 0.12 }
            return (v, (0..<11).map { "\($0 + 9 > 12 ? $0 - 3 : $0 + 9) \($0 + 9 >= 12 ? "PM" : "AM")" }, "today")
        case "1W":
            let v = Array(h.suffix(8))
            return (v, v.indices.map { "\(v.count - 1 - $0)d ago" }, "past week")
        default:
            return (h, h.indices.map { "\(h.count - 1 - $0)d ago" }, "since posted")
        }
    }

    // MARK: Comments

    static let comments: [Comment] = [
        Comment(id: "1", author: mo, position: .faded(10), age: "1h", minutesAgo: 60, likes: 18,
                text: "Power stocks already ran hard this year. Feels priced in to me.",
                replies: [Comment(id: "11", author: jake, position: .author(25), age: "52m", minutesAgo: 52, likes: 24,
                                  text: "Priced for today's demand, not 2027's. Data-center plans keep getting bigger.")]),
        Comment(id: "2", author: priya, position: .backed(50), age: "2h", minutesAgo: 120, likes: 31,
                text: "Adding the data-center spending prediction is smart. Cleanest read on the whole idea."),
        Comment(id: "3", author: dev, position: .faded(25), age: "4h", minutesAgo: 240, likes: 9,
                text: "If rate cuts stall, this whole basket deflates. Fading."),
        Comment(id: "4", author: me, position: .backed(20), age: "5h", minutesAgo: 300, likes: 6,
                text: "In. The group chat has been arguing about this for weeks.")
    ]

    // MARK: Scores

    static let periods = ["Week", "Month", "All time"]

    static func leaderboard(_ period: String) -> (rows: [LeaderRow], me: (cash: Double, pct: Double, cashRank: Int, pctRank: Int)) {
        switch period {
        case "Month":
            return ([LeaderRow(person: priya, takes: 31, cash: 11860, pct: 29.4),
                     LeaderRow(person: lena, takes: 40, cash: 7420, pct: 18.2),
                     LeaderRow(person: jake, takes: 22, cash: 6915, pct: 24.7),
                     LeaderRow(person: dev, takes: 18, cash: 5030, pct: 12.1),
                     LeaderRow(person: mo, takes: 15, cash: 3100, pct: 33.0),
                     LeaderRow(person: kai, takes: 9, cash: 880, pct: 52.3)],
                    (2940, 19.8, 22, 40))
        case "All time":
            return ([LeaderRow(person: lena, takes: 212, cash: 48200, pct: 41.0),
                     LeaderRow(person: priya, takes: 174, cash: 41375, pct: 36.2),
                     LeaderRow(person: mo, takes: 96, cash: 22810, pct: 58.7),
                     LeaderRow(person: jake, takes: 88, cash: 19640, pct: 27.5),
                     LeaderRow(person: kai, takes: 41, cash: 2950, pct: 88.4)],
                    (6118.2, 31.2, 61, 74))
        default:
            return ([LeaderRow(person: priya, takes: 9, cash: 4120, pct: 38.1),
                     LeaderRow(person: jake, takes: 6, cash: 2410, pct: 31.4),
                     LeaderRow(person: lena, takes: 11, cash: 1980, pct: 27.9),
                     LeaderRow(person: mo, takes: 4, cash: 1455, pct: 44.2),
                     LeaderRow(person: kai, takes: 3, cash: 320, pct: 61.0)],
                    (1284.5, 22.6, 14, 31))
        }
    }

    // MARK: Profile

    static let scoreRanges = ["1W", "1M", "All"]

    static func score(_ range: String) -> ScoreSeries {
        switch range {
        case "1M":
            return ScoreSeries(points: [0, 300, 520, 410, 900, 1240, 1180, 1650, 2010, 1890, 2400, 2700, 2940],
                               labels: ["Dec 6", "Dec 8", "Dec 11", "Dec 13", "Dec 16", "Dec 18", "Dec 21", "Dec 23", "Dec 26", "Dec 28", "Dec 31", "Jan 2", "Jan 4"],
                               pct: 19.8, caption: "this month", rank: "#22 this month")
        case "All":
            return ScoreSeries(points: [0, 400, 900, 700, 1500, 2100, 1900, 2800, 3500, 3300, 4200, 4900, 5400, 6118.2],
                               labels: ["Dec 1", "Dec 4", "Dec 6", "Dec 9", "Dec 11", "Dec 14", "Dec 16", "Dec 19", "Dec 21", "Dec 24", "Dec 27", "Dec 30", "Jan 1", "Jan 4"],
                               pct: 31.2, caption: "all time", rank: "#61 all time")
        default:
            return ScoreSeries(points: [0, 120, 340, 290, 610, 880, 1050, 1284.5],
                               labels: ["Dec 28", "Dec 29", "Dec 30", "Dec 31", "Jan 1", "Jan 2", "Jan 3", "Jan 4"],
                               pct: 22.6, caption: "this week", rank: "#14 this week")
        }
    }

    /// Bought at $1.00 a share (when each take was posted), worth today's price.
    static var positions: [OwnedPosition] {
        func held(_ take: Take, _ side: Side, _ cost: Double, count: Int = 1) -> OwnedPosition {
            OwnedPosition(take: take, side: side, amount: cost, shares: cost, price: take.price,
                          value: OwnedPosition.value(side: side, shares: cost, cost: cost, price: take.price),
                          count: count, lastAt: .now)
        }
        return [held(aiPower, .back, 20), held(chips, .fade, 25), held(fedCut, .back, 50, count: 2)]
    }

    static var myTakes: [ProfileItem] {
        [ProfileItem(topic: "topic-coin", claim: "Copper squeeze is coming.", kind: "Called it", kindColor: Palette.up, meta: "settled Dec 30 · 18 traded", value: "+$486", ret: 31.5),
         ProfileItem(topic: "topic-bank", claim: "The Fed cuts in December.", kind: "Called it", kindColor: Palette.up, meta: "settled Dec 16 · 9 traded", value: "+$212", ret: 12.0),
         ProfileItem(topic: "topic-tv", claim: "Streaming bundles beat cable this year.", kind: "Live", kindColor: Palette.text, meta: "ends Feb 15 · 4 traded", value: "−$31", ret: -6.2)]
    }

    static var badges: [ProfileItem] {
        [ProfileItem(topic: "topic-coin", claim: "Copper squeeze is coming.", kind: "Called it", kindColor: Palette.up, meta: "Dec 30 · top 5% return", value: "+$486", ret: 31.5),
         ProfileItem(topic: "topic-bank", claim: "The Fed cuts in December.", kind: "Called it", kindColor: Palette.up, meta: "Dec 16", value: "+$212", ret: 12.0),
         ProfileItem(topic: "topic-rocket", claim: "Faded @dev: Chips rip into earnings.", kind: "Faded right", kindColor: Palette.down, meta: "Dec 12", value: "+$58", ret: 9.1)]
    }

    // MARK: Assets

    static let assets: [Asset] = [
        mockAsset("mock:NVDA", "NVDA", "NVIDIA", "stock", 187.61, 3.3, about: "Designs the chips that train and run most AI models.", short: true),
        mockAsset("mock:AMD", "AMD", "Advanced Micro Devices", "stock", 447.56, 10.2, about: "Makes processors and AI accelerators for PCs and data centers.", short: true),
        mockAsset("mock:MU", "MU", "Micron Technology", "stock", 692.79, 4.8, about: "Makes the memory chips that servers and phones run on."),
        mockAsset("mock:VST", "VST", "Vistra", "stock", 171.20, 1.4, about: "Power producer with nuclear and gas plants."),
        mockAsset("mock:CEG", "CEG", "Constellation", "stock", 298.40, 0.9, about: "Runs the largest fleet of nuclear plants in the US.", short: true),
        mockAsset("mock:BE", "BE", "Bloom Energy", "stock", 172.66, 3.2, about: "Sells fuel-cell power systems that run data centers on site."),
        mockAsset("mock:PAXG", "XAU", "PAX Gold", "commodity", 4056.68, -0.6, about: "A token backed by real gold, one fine troy ounce each."),
        mockAsset("mock:DCCAPEX", "DCCAPEX", "Data-center spending", "prediction", nil, nil, about: "Pays out if big-tech data-center spending clears [threshold] by [date].", short: true),
        Asset(id: "mock:CASH", key: "mock:CASH", symbol: "USDC", name: "Cash", kindLabel: "Earns interest", kind: "yield", venue: "Jupiter Lend",
              about: "Money that isn't invested yet earns interest while the take runs.", themes: [], canShort: false, apyPct: 4.2,
              maxLeverage: nil, expiresAt: nil, available: true, priceUSD: nil, change24hPct: nil),
    ]

    private static func mockAsset(_ id: String, _ symbol: String, _ name: String, _ kind: String, _ price: Double?, _ change: Double?,
                                  about: String, short: Bool = false) -> Asset {
        Asset(id: id, key: kind == "prediction" ? id : symbol, symbol: symbol, name: name,
              kindLabel: kind == "commodity" ? "Commodity" : kind == "prediction" ? "Prediction" : "Stock",
              kind: kind, venue: kind == "prediction" ? "Gemini" : "Jupiter", about: about, themes: [], canShort: short,
              apyPct: nil, maxLeverage: nil, expiresAt: nil, available: true, priceUSD: price, change24hPct: change)
    }

    static func searchAssets(_ q: String) -> [Asset] {
        guard !q.isEmpty else { return assets }
        let words = q.lowercased()
        return assets.filter {
            $0.symbol.lowercased().hasPrefix(words) || $0.name.lowercased().contains(words)
                || ($0.about ?? "").lowercased().contains(words)
        }
    }

    static func assetPage(_ id: String, range: AssetRange) -> AssetPage? {
        guard let a = assets.first(where: { $0.id == id }) else { return nil }
        let n = range == .day ? 48 : 40
        let base = a.priceUSD ?? 1
        let chart = a.priceUSD == nil ? [] : (0..<n).map { i -> Double in
            let t = Double(i) / Double(n - 1)
            return base * (1 - (a.change24hPct ?? 0) / 100 * (1 - t)) * (1 + 0.012 * sin(t * 9 + Double(a.symbol.count)))
        }
        return AssetPage(asset: a, about: a.about, issuer: nil,
                         fadeHow: a.canShort ? (a.kind == "prediction" ? "Bets No" : "Bets the stock falls") : nil,
                         unavailableNote: nil, price: a.priceUSD, change24hPct: a.change24hPct, chart: chart, chartRange: range)
    }

    /// Offline "Change something…": "add X" / "remove X" by name, like the server's fallback.
    static func edit(_ legs: [Leg], ask: String) -> BuiltBasket {
        let a = ask.trimmingCharacters(in: .whitespaces).lowercased()
        func named(_ text: String) -> Asset? {
            assets.first { $0.symbol.lowercased() == text || $0.name.lowercased() == text || $0.name.lowercased().hasPrefix(text) }
        }
        if let range = a.range(of: #"^(add|include)\s+"#, options: .regularExpression) {
            let what = String(a[range.upperBound...])
            guard let asset = named(what) else {
                return BuiltBasket(legs: legs, summary: nil, noExposureReason: nil, note: "Couldn't find \(what).")
            }
            return BuiltBasket(legs: BasketMath.adding(asset, to: legs), summary: nil, noExposureReason: nil)
        }
        if let range = a.range(of: #"^(remove|drop|no)\s+"#, options: .regularExpression) {
            let what = String(a[range.upperBound...])
            if let leg = legs.first(where: { $0.name.lowercased().hasPrefix(what) }) {
                return BuiltBasket(legs: BasketMath.removing(leg, from: legs), summary: nil, noExposureReason: nil)
            }
        }
        return BuiltBasket(legs: legs, summary: nil, noExposureReason: nil, note: "Couldn't make that change. Try saying it another way.")
    }

    /// Offline risk change that keeps your picks: low adds Cash, high and medium drop it.
    static func adjust(_ legs: [Leg], risk: Risk) -> [Leg] {
        var kept = legs.filter { $0.kind != "Earns interest" && !$0.kind.contains("2x") }
        if kept.isEmpty { kept = legs }
        guard risk == .low, let cash = assets.first(where: { $0.kind == "yield" }) else { return BasketMath.normalized(kept) }
        return BasketMath.normalized(kept.map { var l = $0; l.weight *= 0.75; return l }
                                     + [cash.leg(weight: 25, slot: BasketMath.nextSlot(kept))])
    }
}

extension MockData {
    /// Copying X accounts, for previews and offline builds.
    static let xAccounts: [XAccount] = [
        XAccount(handle: "kobeissiletter", username: "KobeissiLetter", name: "The Kobeissi Letter", avatarUrl: nil, calls: [
            XCall(postId: "2121729777891496181", url: URL(string: "https://x.com/KobeissiLetter/status/2121729777891496181")!,
                  text: "Crypto is having an absolutely brutal weekend. Bitcoin is now down -$5,000 today and -$11,000 over the last 3 days.",
                  postedAt: .now.addingTimeInterval(-3600 * 2), claim: "Bitcoin's selloff has further to run as liquidations pile up",
                  risk: "high", horizon: "1 month"),
            XCall(postId: "2121716781534314731", url: URL(string: "https://x.com/KobeissiLetter/status/2121716781534314731")!,
                  text: "BREAKING: Bitcoin falls below $65,000 and ETH falls below $1,750 as total liquidations hit $1.8 billion.",
                  postedAt: .now.addingTimeInterval(-3600 * 4), claim: "Ether keeps sliding below $1,750 this month",
                  risk: "high", horizon: "1 month"),
        ]),
    ]
}
