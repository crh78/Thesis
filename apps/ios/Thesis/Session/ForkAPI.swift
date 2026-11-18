import Foundation

/// The signed-in user's Privy Solana wallet: its address and a signer that adds the wallet's
/// signature to a transaction without sending it.
struct ForkWallet {
    let address: String
    let sign: (Data) async throws -> Data
    /// Signs a short text (Privy's signMessage), to prove the wallet is yours. Returns the signature.
    var signMessage: (String) async throws -> Data = { _ in throw ForkAPIError(code: "cant_sign_message", message: nil) }
}

/// The fork API (`scripts/fork/api`, on the team's shared fork), for the whole product on a
/// mainnet fork with fake money. The app's only money path: every build needs `FORK_API_URL`
/// (`Config/Fork.local.xcconfig`, gitignored), or it stops at launch.
///
/// Trades are real on-chain receipts plus Jupiter swaps from the user's own wallet: the API builds
/// the transactions, the Privy wallet signs them here, and the API adds the app's fee payer
/// signature and sends them to the fork.
struct ForkAPI {
    let base: URL
    let wallet: ForkWallet
    /// The signed-in user's Privy access token, sent with money requests.
    var accessToken: () async throws -> String = { throw ForkAPIError(code: "unauthorized", message: nil) }

    // MARK: Takes

    func receipt(_ takeID: String) async throws -> ForkReceipt {
        try await get("takes/\(takeID)", query: [URLQueryItem(name: "viewer", value: wallet.address)])
    }

    // A trade is two steps, so the slow one happens before the tap: `prepareTrade` builds it (the
    // sheet does that as it opens, and again as the amount changes), and `commit` signs and sends
    // it when you tap. `prebuild` marks a build made ahead of a tap: the fork API counts the money
    // action at submit instead (older fork APIs ignore it).

    /// Builds a back (or fade) of a take for `amount`, ready to sign.
    func prepareTrade(_ takeID: String, side: Side, amount: Double, prebuild: Bool = false) async throws -> ForkPrepared {
        struct Body: Encodable { let owner: String; let side: String; let usd: Double; let prebuild: Bool? }
        let body = Body(owner: wallet.address, side: side == .back ? "back" : "fade", usd: amount, prebuild: prebuild ? true : nil)
        return try await prepared { try await post("takes/\(takeID)/trades", body) }
    }

    /// Builds the sale of one position (the whole position), ready to sign.
    func prepareExit(_ takeID: String, position: String, prebuild: Bool = false) async throws -> ForkPrepared {
        struct Body: Encodable { let owner: String; let prebuild: Bool? }
        let body = Body(owner: wallet.address, prebuild: prebuild ? true : nil)
        return try await prepared { try await post("takes/\(takeID)/positions/\(position)/exit", body) }
    }

    /// The same build with a fresh blockhash (and its quote, when that's old). Nil when it has to be
    /// built again: the quote is too old, the build is gone, or the fork API can't refresh builds.
    func refresh(_ old: ForkPrepared) async throws -> ForkPrepared? {
        struct Empty: Encodable {}
        do {
            let fresh = try await prepared { try await post("builds/\(old.build.buildId)/refresh", Empty()) }
            return ForkPrepared(build: fresh.build.keeping(old.build), expires: fresh.expires)
        } catch let e as ForkAPIError where Self.buildAgain.contains(e.code) {
            return nil
        }
    }

    private static let buildAgain: Set<String> = ["quote_stale", "build_gone", "build_expired", "no_such_route", "http_404", "http_409", "http_410"]

    /// Signs every transaction of a build at once and sends them. Returns as soon as the fork has
    /// accepted them (`pending`: confirmation follows, see `submission`), or, from a fork API that
    /// confirms before it answers, once they landed. `marks` go along as the submit's `timings`.
    func commit(_ build: ForkBuild, marks: TradeMarks? = nil) async throws -> ForkSubmission {
        let signed = try await signAll(build, marks: marks)
        marks?.mark("signed")
        struct Body: Encodable { let buildId: String; let transactions: [String]; let until: String; let timings: [String: Double]? }
        marks?.mark("submit")
        return try await post("submit", Body(buildId: build.buildId, transactions: signed, until: "accepted", timings: marks?.values),
                              authorized: false)
    }

    /// Where a submitted build stands. Waits up to `wait` seconds while it's pending (a long poll).
    /// Nil when the fork API doesn't know it (or can't answer this): check the wallet instead.
    func submission(_ buildID: String, wait: Int = 10) async throws -> ForkSubmission? {
        var req = URLRequest(url: base.appending(path: "submissions/\(buildID)").appending(queryItems: [
            URLQueryItem(name: "wait", value: String(wait * 1000)),
        ]))
        req.timeoutInterval = TimeInterval(wait + 15)
        do {
            return try await send(req)
        } catch let e as ForkAPIError where e.code == "no_such_route" || e.code == "http_404" || e.code == "not_found" {
            return nil
        }
    }

    /// How long a build is good for after it was asked for, if the fork API doesn't say (its
    /// builds last 55 s from when it starts on them).
    static let buildLifetime: TimeInterval = 50

    private func prepared(_ build: () async throws -> ForkBuild) async throws -> ForkPrepared {
        let asked = Date.now
        let built = try await build()
        var expires = asked.addingTimeInterval(Self.buildLifetime)
        // The API's own expiry, when it gives one, on its clock: never later than ours.
        if let at = built.expiresAt { expires = min(expires, Date(timeIntervalSince1970: at / 1000)) }
        return ForkPrepared(build: built, expires: expires)
    }

    /// Puts a just-posted take on-chain with the author's buy-in. When the build leaves legs out,
    /// `confirm` is asked first (nothing is signed if it says no: `post_cancelled`).
    @discardableResult
    func publish(_ takeID: String, amount: Double, confirm: (([ForkBuild.LeftOut]) async -> Bool)? = nil) async throws -> [String] {
        struct Body: Encodable { let author: String; let usd: Double }
        let built: ForkBuild = try await post("takes/\(takeID)/publish", Body(author: wallet.address, usd: amount))
        if let left = built.excluded, !left.isEmpty, let confirm, !(await confirm(left)) {
            throw ForkAPIError(code: "post_cancelled", message: nil)
        }
        return try await signAndSubmit(built)
    }

    struct PublishCheck: Decodable { let onChain: Bool; let relayed: Int }

    /// Whether a take's publish landed on the fork; if it did, the API delivers its events to the
    /// backend again, which makes the take live.
    func confirmPublish(_ takeID: String) async throws -> PublishCheck {
        struct Empty: Encodable {}
        return try await post("takes/\(takeID)/confirm", Empty())
    }

    /// Signs and sends a build, and returns once it landed (posting, claims, Phoenix cash-out).
    func signAndSubmit(_ built: ForkBuild) async throws -> [String] {
        let signed = try await signAll(built, marks: nil)
        struct Body: Encodable { let buildId: String; let transactions: [String] }
        struct Sent: Decodable { let signatures: [String] }
        let sent: Sent = try await post("submit", Body(buildId: built.buildId, transactions: signed), authorized: false)
        return sent.signatures
    }

    /// The wallet's signature on every transaction, all asked for at once, in the build's order.
    private func signAll(_ built: ForkBuild, marks: TradeMarks?) async throws -> [String] {
        let txs = try built.transactions.map { b64 in
            guard let tx = Data(base64Encoded: b64) else { throw ForkAPIError(code: "bad_transaction", message: nil) }
            return tx
        }
        let sign = wallet.sign
        return try await withThrowingTaskGroup(of: (Int, String).self) { group in
            for (i, tx) in txs.enumerated() {
                group.addTask { (i, try await sign(tx).base64EncodedString()) }
            }
            var signed = [String](repeating: "", count: txs.count)
            for try await (i, sig) in group {
                signed[i] = sig
                marks?.mark("sign_\(i)")
            }
            return signed
        }
    }

    /// The program's rules: the fee, the creator's share, the minimum stake (the config account).
    func config() async throws -> ForkConfig { try await get("config") }

    // MARK: Cash

    func summary() async throws -> ForkWalletSummary { try await get("wallets/\(wallet.address)") }

    /// Your open positions across takes, and the badges your wallet holds on-chain.
    func portfolio() async throws -> ForkPortfolio { try await get("wallets/\(wallet.address)/portfolio") }

    // MARK: Phoenix

    /// Cash left on Phoenix outside your open positions (after a sale), and Phoenix positions still
    /// open whose take is over.
    func phoenixCash() async throws -> ForkPhoenixCash { try await get("wallets/\(wallet.address)/phoenix") }

    /// Moves cash left on Phoenix back to your wallet as USDC, closing any positions left open
    /// first. Each round is a build you sign; it repeats until nothing is left (at most a few).
    func cashOutPhoenix() async throws {
        struct Empty: Encodable {}
        struct Round: Decodable { let done: Bool; let buildId: String?; let transactions: [String]? }
        for _ in 0..<4 {
            let round: Round = try await post("wallets/\(wallet.address)/phoenix/cash-out", Empty())
            guard !round.done, let id = round.buildId, let txs = round.transactions else { return }
            _ = try await signAndSubmit(ForkBuild(buildId: id, transactions: txs, expectedUsd: nil, minimumUsd: nil, phoenixCashOut: nil, excluded: nil))
        }
    }

    // MARK: Creator fees

    /// What you earned as a creator, per take: earned, claimed and left to claim. Only your own:
    /// the wallet signs a short-lived message the API checks.
    func creatorFees() async throws -> ForkCreatorFees {
        let at = Int(Date.now.timeIntervalSince1970)
        let signature = try await wallet.signMessage("Thesis creator fees \(wallet.address) \(at)")
        var req = URLRequest(url: base.appending(path: "wallets/\(wallet.address)/creator-fees"))
        req.setValue("\(at).\(signature.base64EncodedString())", forHTTPHeaderField: "x-thesis-wallet-auth")
        return try await send(req)
    }

    /// Claims your creator fees: these takes (on-chain addresses), or all of them. As many claims
    /// per transaction as fit; you sign each. Returns the transaction signatures.
    @discardableResult
    func claimCreatorFees(takes: [String]?) async throws -> [String] {
        struct Body: Encodable { let takes: [String]? }
        let built: ForkBuild = try await post("wallets/\(wallet.address)/creator-fees/claim", Body(takes: takes))
        return try await signAndSubmit(built)
    }

    /// Your portfolio's value over `range` ("1D", "1W", "1M" or "ALL").
    func history(_ range: String) async throws -> ForkHistory {
        try await get("wallets/\(wallet.address)/history", query: [URLQueryItem(name: "range", value: range)])
    }

    func deposit(_ amount: Double) async throws -> ForkWalletSummary {
        try await post("wallets/\(wallet.address)/deposits", Amount(usd: amount))
    }

    private struct Amount: Encodable { let usd: Double }

    // MARK: HTTP

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var url = base.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        return try await send(URLRequest(url: url))
    }

    /// `authorized: false` for /submit, which needs no token (the API only sends what it built, and
    /// checks the wallet's signature on it), so the tap doesn't wait on Privy for one.
    private func post<T: Decodable, B: Encodable>(_ path: String, _ body: B, authorized: Bool = true) async throws -> T {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        // Money routes need proof the wallet is yours: your Privy access token (the fork API's
        // abuse limits, scripts/fork/README.md). Sent on every other POST; harmless where it isn't needed.
        if authorized, let token = try? await tokens.token(accessToken) {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        req.httpBody = try JSONEncoder().encode(body)
        // Building runs Jupiter routing and, the first time, mirrors a demo take on-chain.
        req.timeoutInterval = 90
        return try await send(req)
    }

    /// One session for the fork API, kept for the app's life, so trades reuse a warm connection
    /// (the sheet's first build or receipt read opens it) instead of queueing behind images.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: config)
    }()

    /// The Privy token, reused while it's good (each copy of this API shares it).
    private let tokens = TokenCache()

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await Self.session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let err = try? Self.decoder.decode(ForkAPIError.self, from: data)
            throw err ?? ForkAPIError(code: "http_\(status)", message: nil)
        }
        return try Self.decoder.decode(T.self, from: data)
    }
}

/// The Privy access token for fork API calls, reused until a minute before it expires (at most
/// five minutes), so a trade doesn't ask Privy for one on every request.
private actor TokenCache {
    private var token: String?
    private var until = Date.distantPast

    func token(_ fetch: () async throws -> String) async throws -> String {
        if let token, Date.now < until { return token }
        let fresh = try await fetch()
        token = fresh
        until = min(Date.now.addingTimeInterval(300), Self.expiry(of: fresh)?.addingTimeInterval(-60) ?? .now)
        return fresh
    }

    /// A JWT's `exp`, if it reads as one.
    private static func expiry(of jwt: String) -> Date? {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = claims["exp"] as? Double else { return nil }
        return Date(timeIntervalSince1970: exp)
    }
}

/// A build ready to sign, and when it stops being sendable (its blockhash), on this phone's clock.
struct ForkPrepared {
    let build: ForkBuild
    let expires: Date
    /// When the answer came in.
    var madeAt = Date.now

    /// Signing and sending take well under a second; this leaves room for a slow network.
    static let sendMargin: TimeInterval = 5
    /// A sheet that's still open refreshes a build with less than this left.
    static let refreshBelow: TimeInterval = 15

    var secondsLeft: TimeInterval { expires.timeIntervalSinceNow }
    var isFresh: Bool { secondsLeft > Self.sendMargin }
}

/// What `POST /submit` and `GET /submissions/:buildId` answer.
struct ForkSubmission: Decodable {
    enum Status: String { case pending, landed, failed, incomplete }

    struct Problem: Decodable, Equatable {
        let code: String
        let message: String?
    }

    /// Nil from a fork API that confirms before it answers: then it has landed.
    private let status: String?
    let signatures: [String]?
    let error: Problem?

    var state: Status { status.flatMap(Status.init(rawValue:)) ?? .landed }

    init(state: Status, signatures: [String]? = nil, error: Problem? = nil) {
        status = state.rawValue
        self.signatures = signatures
        self.error = error
    }
}

/// When each step of a trade happened, in ms after the tap (a build made before the tap is
/// negative). Sent with the submit as `timings`, which the fork API logs with the build.
final class TradeMarks: @unchecked Sendable {
    private let start = Date.now
    private let lock = NSLock()
    private var marks: [String: Double] = [:]

    func mark(_ name: String, at date: Date = .now) {
        let ms = (date.timeIntervalSince(start) * 1000).rounded()
        lock.withLock { marks[name] = ms }
    }

    var values: [String: Double] { lock.withLock { marks } }
}

struct ForkAPIError: Error, Decodable, LocalizedError {
    let code: String
    let message: String?

    enum CodingKeys: String, CodingKey { case code = "error", message }

    var errorDescription: String? {
        switch code {
        case "insufficient_funds": "Not enough cash in your wallet."
        // The fork API couldn't check who you are (no token, or an expired one): sign in again.
        case "unauthorized", "http_401": "Sign in again to keep trading."
        case "wrong_wallet": "This wallet isn't the one you're signed in with. Sign in again."
        case "invalid_amount": message ?? "That amount doesn't work."
        case "build_expired": "That took too long. Try again."
        // A back or fade on a take whose author sold their buy-in.
        case "take_closed": "This take is closed: its author sold, so it takes no new trades or fades."
        default: message ?? "The fork didn't take that (\(code))."
        }
    }
}

/// The program's rules as the fork API reads them from the config account (`GET /config`).
struct ForkConfig: Decodable, Equatable {
    let feeBps: Int
    let creatorFeeBps: Int
    /// The fee as a fraction of the stake: 0.001 for 10 bps.
    let feeRate: Double
    let minStakeUsd: Double
    let maxLegs: Int
    let paused: Bool
}

struct ForkBuild: Decodable {
    let buildId: String
    let transactions: [String]
    let expectedUsd: Double?
    let minimumUsd: Double?
    /// A sale that closed Phoenix legs: their cash moves back to USDC with `cashOutPhoenix()`.
    let phoenixCashOut: Bool?
    /// Legs this trade or post leaves out, and why (a name the fork can't buy right now).
    let excluded: [LeftOut]?
    /// A sale of the author's own buy-in on an open take: it closes the take (no new trades, and
    /// its result is final at today's prices). Missing on older forks and on other builds.
    var closesTake: Bool? = nil
    /// Unix ms: when the transactions' blockhash expires, and when the quote behind them was made.
    /// Missing on older fork APIs (`ForkAPI.buildLifetime` stands in).
    var expiresAt: Double? = nil
    var quotedAt: Double? = nil

    struct LeftOut: Decodable, Equatable {
        let name: String
        let reason: String
    }

    /// A refreshed build, with what it left out of its answer taken from the build it replaces.
    func keeping(_ old: ForkBuild) -> ForkBuild {
        ForkBuild(buildId: buildId, transactions: transactions, expectedUsd: expectedUsd ?? old.expectedUsd,
                  minimumUsd: minimumUsd ?? old.minimumUsd, phoenixCashOut: phoenixCashOut ?? old.phoenixCashOut,
                  excluded: excluded ?? old.excluded, closesTake: closesTake ?? old.closesTake,
                  expiresAt: expiresAt, quotedAt: quotedAt ?? old.quotedAt)
    }
}

/// Cash left on Phoenix (fork mode): see `ForkAPI.phoenixCash()`.
struct ForkPhoenixCash: Decodable, Equatable {
    let cashUsd: Double
    let openPositions: Int
    let markets: [String]
}

/// A take as the chain sees it (fork mode).
struct ForkReceipt: Decodable, Equatable {
    struct Leg: Decodable, Equatable {
        let index: Int
        let name: String
        let tradable: Bool
        /// Why this leg can't be traded on the fork yet, if it can't.
        let blocked: String?
        /// Why a fade leaves this leg out (no market on a prediction's other side, or no Phoenix short), or nil if it can be faded.
        let fadeBlocked: String?
        /// Earns yield (Jupiter Lend): priced as one vault share's value; its interest counts in the score.
        let yield: Bool?
        /// A perp leg: the Phoenix market a back goes long on, and its leverage.
        let perp: Perp?
        /// The Phoenix market a fade shorts this leg on, if any.
        let short: String?

        struct Perp: Decodable, Equatable {
            let symbol: String
            let leverage: Int
        }
        let authorEntryUsd: Double?
        let currentUsd: Double?
        /// A Gemini prediction leg: the contract, the side the take holds, and its market now.
        let prediction: Prediction?

        struct Prediction: Decodable, Equatable {
            struct Sides: Decodable, Equatable {
                let yes: Double?
                let no: Double?
            }
            let instrument: String
            let event: String
            let label: String
            /// "yes" or "no": the side a back holds. A fade holds the other one.
            let side: String
            /// What buying each side costs now, and what selling it pays (0–1).
            let ask: Sides
            let bid: Sides
            let expiry: String?

            /// The side a position on this leg holds.
            func held(fade: Bool) -> String { fade ? (side == "yes" ? "no" : "yes") : side }
            /// What buying that side costs now, 0–1.
            func price(fade: Bool) -> Double? { held(fade: fade) == "yes" ? ask.yes : ask.no }
        }
    }

    struct Holding: Decodable, Equatable {
        let address: String
        let side: String
        let stakeUsd: Double
        let openedAt: Int
        /** The score's return: on-chain entry prices against live prices on the same source. */
        let returnBps: Int?
        /** What the trade cost the wallet (stake plus the fee), and what its tokens are worth now. */
        let costUsd: Double?
        let valueUsd: Double?
        /** Why some legs have no entry price yet ("... when the stock market opens"). */
        let pendingNote: String?
        let canExit: Bool?
        let exited: Bool?
        /** The prediction legs' share of the stake, held until the position settles. */
        let escrowedUsd: Double?
        /** Legs held on Phoenix (leverage, shorts): where each is liquidated and how close it is. */
        let phoenix: [PhoenixRisk]?

        struct PhoenixRisk: Decodable, Equatable {
            let leg: Int
            let symbol: String
            /** "long" or "short". */
            let side: String
            let entryUsd: Double
            let markUsd: Double?
            /** Nil when price alone can't liquidate it. */
            let liquidationUsd: Double?
            /** The move to liquidation, as a share of the market (0.18 = 18% away). */
            let distance: Double?
            /** "ok", "near" (within 25%) or "close" (within 10%). */
            let level: String
        }

        /** Profit or loss on what the wallet actually holds. */
        var pnl: (usd: Double, pct: Double)? {
            guard let costUsd, let valueUsd, costUsd > 0 else { return nil }
            return (valueUsd - costUsd, valueUsd / costUsd - 1)
        }

        /** Just traded and still waiting for its entry prices: worth re-reading soon. */
        var isFresh: Bool { returnBps == nil && Date().timeIntervalSince1970 - Double(openedAt) < 120 }
    }

    let onChain: Bool
    let address: String?
    /// "open", "closed" (the author sold their buy-in: no new trades) or "settled". Older forks
    /// say only "open" or "settled".
    let status: String?
    /// Unix seconds: when the author's sale closed it (nil while open; missing on older forks).
    let closedAt: Double?
    /// Unix seconds: when it settles by itself if the author never sells (a year after posting).
    let horizonEnd: Double?
    let backers: Int?
    let faders: Int?
    let totalBackedUsd: Double?
    let totalFadedUsd: Double?
    /// The take's result once settled; before that, the author's position at current prices.
    let returnBps: Int?
    let legs: [Leg]
    let viewerPositions: [Holding]?
    let canBack: Bool
    let canFade: Bool
    let fadeBlocked: String?
    /// Set when a take a real user posted isn't on this fork (it was reset since): why it can't be traded.
    let missing: String?

    var leftOut: [Leg] { legs.filter { !$0.tradable } }
}

/// Your positions and badges on the fork (profile page).
/// Your creator fees (fork API `GET /wallets/:address/creator-fees`). Amounts are exact: base units
/// as strings, and the same in dollars.
struct ForkCreatorFees: Decodable, Equatable {
    struct Take: Decodable, Equatable, Identifiable {
        let take: String
        let takeId: String?
        let claim: String?
        let earnedUsd: Double
        let claimedUsd: Double
        let unclaimedUsd: Double
        var id: String { take }
    }

    let earnedUsd: Double
    let claimedUsd: Double
    let unclaimedUsd: Double
    let takes: [Take]
}

struct ForkPortfolio: Decodable, Equatable {
    struct Position: Decodable, Equatable {
        let address: String
        let takeId: String
        let claim: String
        let topic: String?
        let authorHandle: String?
        let side: String
        let stakeUsd: Double
        let costUsd: Double?
        let valueUsd: Double?
        /// The score's return (on-chain prices), once entry prices are in.
        let returnBps: Int?
        let pendingNote: String?
        let canExit: Bool?
        let exited: Bool?
    }

    struct Badge: Decodable, Equatable {
        let kind: String
        let title: String
        let mint: String
        /// The badge's art (Supabase Storage, from the config's badge URI base).
        let image: String?
    }

    let positions: [Position]
    let badges: [Badge]
}

extension ForkPortfolio {
    /// One row per take and side. Every buy is its own position on-chain, but buying the same take
    /// twice is one holding to you: amounts add up, and the return is weighted by stake.
    var holdings: [Position] {
        var order: [String] = []
        var groups: [String: [Position]] = [:]
        for p in positions {
            let key = "\(p.takeId)|\(p.side)"
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(p)
        }
        return order.compactMap { key in
            guard let group = groups[key], let first = group.first else { return nil }
            if group.count == 1 { return first }
            func total(_ value: (Position) -> Double?) -> Double? {
                let values = group.compactMap(value)
                return values.count == group.count ? values.reduce(0, +) : nil
            }
            let stake = group.reduce(0) { $0 + $1.stakeUsd }
            let returns = group.compactMap { p in p.returnBps.map { Double($0) * p.stakeUsd } }
            return Position(
                address: first.address, takeId: first.takeId, claim: first.claim, topic: first.topic,
                authorHandle: first.authorHandle, side: first.side, stakeUsd: stake,
                costUsd: total(\.costUsd), valueUsd: total(\.valueUsd),
                returnBps: returns.count == group.count && stake > 0 ? Int((returns.reduce(0, +) / stake).rounded()) : nil,
                pendingNote: group.lazy.compactMap(\.pendingNote).first,
                canExit: group.contains { $0.canExit == true },
                exited: group.allSatisfy { $0.exited == true })
        }
    }
}

/// Your portfolio over a range (cash plus what your positions are worth). Deposits and withdrawals
/// are taken out of the line, so only gains, losses and fees move it.
struct ForkHistory: Decodable, Equatable {
    struct Point: Decodable, Equatable {
        /// Unix seconds.
        let at: Double
        let value: Double
    }

    let value: Double
    let change: Double
    let changePct: Double
    let points: [Point]
}

struct ForkWalletSummary: Decodable {
    struct Holding: Decodable {
        let mint: String
        let symbol: String?
        let amount: Double
    }

    struct Activity: Decodable {
        let kind: String
        let usd: Double
        let at: String
        let takeId: String?
        let signature: String?
    }

    let usdc: Double
    let holdings: [Holding]
    let activity: [Activity]
}
