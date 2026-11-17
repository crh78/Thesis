import SwiftUI
import Observation
import os

/// Screens reachable from the profile sidebar, follower counts, and any person.
enum PeopleRoute: Hashable {
    case saved
    /// Your followers / following.
    case connections(ConnectionsTab)
    /// Someone else's profile (yours is the Me tab).
    case person(Person)
    /// Someone else's followers / following.
    case personConnections(Person, ConnectionsTab)
    case settings
    /// An asset's page (catalog id, `securities.id`).
    case asset(String)
}

/// Someone's profile page data.
struct PersonDetail {
    var person: Person
    var followers: Int
    var following: Int
    var takes: [Take]
    var privacy = FollowPrivacy()
}

/// Who can see someone's follow lists. Counts are always public.
struct FollowPrivacy: Equatable {
    var showFollowing = true
    var showFollowers = true

    func shows(_ tab: ConnectionsTab) -> Bool { tab == .following ? showFollowing : showFollowers }
}

/// `profile` read: a person, their counts and list privacy.
struct ProfileDetail {
    let person: Person
    let followers: Int
    let following: Int
    let privacy: FollowPrivacy
}

/// A follow list on someone's profile.
enum PeopleList {
    case people([Person])
    /// They keep this list private.
    case hidden
    case failed(String)
}

/// Home's two swipeable feeds.
enum FeedPage: Int, Hashable, CaseIterable {
    case forYou, following

    var title: String { self == .forYou ? "For you" : "Following" }
}

enum ConnectionsTab: String, Hashable, CaseIterable {
    case followers = "Followers"
    case following = "Following"
}

enum LoadState: Equatable {
    case idle, loading, loaded
    case failed(String)
}

/// App-wide state: navigation (tab, sidebar, Home stack) and the social data —
/// feeds, saves, follows, your profile.
///
/// Signed in, `connect` points it at the backend: data loads from `SocialAPI`
/// and every change is applied right away, sent, and rolled back if it fails.
/// Without a connection (UI tests, `-screen` previews) it runs on `MockData`.
@MainActor @Observable
final class AppState {
    // MARK: Navigation

    var tab: AppTab = .home
    var drawerOpen = false
    var showAddCash = false
    var showWithdraw = false
    var showCash = false
    /// A take opened from a chat link: RootView shows it built, ready to buy in.
    var openedTake: TakeLink?
    /// "Make a take with this" on an asset page: opens the composer with the asset in the basket.
    var seededTake: Asset?
    var openedReceipt: TakeReceiptLink?
    var homePath = NavigationPath()
    var feedPage: FeedPage = .forYou
    /// How far Home's pager is pulled past "For you" (in page widths); the
    /// sidebar slides in with it.
    var sidebarPull: CGFloat = 0

    /// Swipe-right-to-open via the sidebar's own gesture. Home handles it
    /// through its pager instead (`sidebarPull`), so only Scores uses this.
    var sidebarSwipeEnabled: Bool { tab == .scores }

    // MARK: Data

    /// Your cash. Signed in, it's whatever the server's ledger says.
    private(set) var balance: Double = MockData.balance
    /// Deposits, withdrawals, trades and fades, newest first.
    private(set) var cashActivity: [CashEntry] = []
    /// Fork mode: your open positions and on-chain badges, for the profile.
    private(set) var forkPortfolio: ForkPortfolio? { didSet { updateMyReturn() } }
    /// Fork mode: what you earned as a creator, per take. Only you see it (your own profile).
    private(set) var creatorFees: ForkCreatorFees?
    /// Fork mode: cash left on Phoenix after a sale, or positions left open after a take settled.
    private(set) var phoenixCash: ForkPhoenixCash?
    /// Fork mode: your portfolio chart by range ("1D", "1W", "1M", "All"), loaded as you pick one.
    private(set) var portfolioHistory: [String: ForkHistory] = [:]
    /// Your inbox (newest first) and how many are unread.
    private(set) var notifications: [AppNotification] = []
    private(set) var unreadNotifications = 0
    /// More (older) activity is on the server than `cashActivity` holds.
    private(set) var cashHasMore = false
    /// Takes you hold shares in, valued at today's price.
    private(set) var positions: [OwnedPosition] = MockData.positions { didSet { updateMyReturn() } }
    private(set) var loadingMoreCash = false
    /// Trades and fades take any amount from `minTrade` up to your balance
    /// (the server checks both). The Trade sheet starts at `defaultTradeAmount`.
    static let minTrade: Double = 1
    static let defaultTradeAmount: Double = 20

    private(set) var me: Person = MockData.me
    private(set) var forYou: [Take] = MockData.feed
    private(set) var followingFeed: [Take] = []
    private(set) var savedTakes: [Take] = [MockData.nuclear, MockData.mortgage]
    private(set) var myTakes: [Take] = []
    /// Profile ids you follow.
    private(set) var following: Set<String> = Set(MockData.followingBase.map(\.profileID))
    private(set) var followingPeople: [Person] = []
    /// People to follow ("Suggested for you"); mock data until connected.
    private(set) var suggested: [Suggestion] = MockData.everyone
        .filter { !Set(MockData.followingBase.map(\.profileID)).contains($0.profileID) }
        .map { Suggestion(person: $0, reason: "Top caller") }
    private(set) var followers: [Person] = MockData.followers
    /// Who can see your follow lists (Settings → Privacy).
    private(set) var privacy = FollowPrivacy()
    private(set) var feedState: LoadState = .idle
    /// Fork mode: your takes still waiting for their on-chain buy-in, by take id. Nobody else sees
    /// them until the chain confirms (supabase/migrations/*_post_after_chain.sql).
    private(set) var postStates: [String: PostState] = [:]
    /// A failed action, shown as a banner; cleared when shown.
    var actionError: String?

    @ObservationIgnored private var api: SocialAPI?
    /// Fork mode (Debug builds with Config/Fork.local.xcconfig): cash is the wallet's fake USDC on
    /// the mainnet fork, and trades are real on-chain receipts plus swaps from the user's wallet.
    @ObservationIgnored private var fork: ForkAPI?
    private(set) var isOnFork = false

    /// Fork mode: the program's fee, minimum stake and limits, from the fork API (the config
    /// account), so the app never hard-codes them. Nil until loaded.
    private(set) var forkConfig: ForkConfig?
    /// The fee as a fraction of the stake (0.001 for the program's 10 bps), once known.
    var forkFeeRate: Double? { forkConfig?.feeRate }

    /// The smallest trade. On the fork it's the program's minimum stake ($10 unless the config says otherwise).
    var minTrade: Double { isOnFork ? (forkConfig?.minStakeUsd ?? 10) : Self.minTrade }
    @ObservationIgnored private let log = Logger(subsystem: "xyz.yourthesis.app", category: "social")

    var isLive: Bool { api != nil }

    init() {
        followingFeed = mockFollowingFeed()
        followingPeople = MockData.everyone.filter { following.contains($0.profileID) }
    }

    var saved: Set<String> { Set(savedTakes.map(\.id)) }
    // Mock counts mirror the mockups; live counts are real.
    var followingCount: Int { isLive ? following.count : 124 + following.count }
    var followerCount: Int { isLive ? followers.count : 342 }

    // MARK: Connecting

    /// Keeps `me` in step with the session profile, e.g. after a new profile photo.
    func updateMe(from profile: RemoteProfile) {
        guard isLive, profile.id == me.remoteID else { return }
        me = Person(id: profile.handle ?? me.id, name: profile.displayName ?? me.name,
                    made: me.made, returnPct: me.returnPct, takes: me.takes, bio: me.bio,
                    remoteID: profile.id, avatarURL: profile.avatarUrl,
                    backersMade: me.backersMade, backersPct: me.backersPct)
    }

    /// Switches to the backend for the signed-in user and loads everything.
    func connect(api: SocialAPI, profile: RemoteProfile, fork: ForkAPI? = nil) async {
        guard self.api == nil else { return }
        self.api = api
        self.fork = fork
        isOnFork = fork != nil
        me = Person(id: profile.handle ?? "you", name: profile.displayName ?? profile.handle ?? "You",
                    made: 0, returnPct: 0, takes: 0, remoteID: profile.id, avatarURL: profile.avatarUrl)
        forYou = []
        followingFeed = []
        savedTakes = []
        myTakes = []
        following = []
        followingPeople = []
        followers = []
        privacy = FollowPrivacy()
        suggested = []
        balance = 0
        positions = []
        cashActivity = []
        notifications = []
        unreadNotifications = 0
        postStates = [:]
        await loadForkConfig()
        await refresh()
        await refreshNotifications()
        await LocalNotifier.requestAuthorization()
    }

    /// Fork mode: reads the program's rules once (again if the last try failed).
    func loadForkConfig() async {
        guard let fork, forkConfig == nil else { return }
        do {
            forkConfig = try await fork.config()
        } catch {
            log.error("fork config: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Signed out: drop the connection and everything loaded for that account.
    func disconnect() {
        guard api != nil else { return }
        api = nil
        fork = nil
        isOnFork = false
        forkConfig = nil
        forkPortfolio = nil
        creatorFees = nil
        portfolioHistory = [:]
        forYou = []
        followingFeed = []
        savedTakes = []
        myTakes = []
        following = []
        followingPeople = []
        followers = []
        privacy = FollowPrivacy()
        suggested = []
        balance = 0
        positions = []
        cashActivity = []
        postStates = [:]
        feedState = .idle
        homePath = NavigationPath()
        tab = .home
    }

    /// Reloads feeds, saves, people and your profile.
    func refresh() async {
        guard let api else { return }
        let myID = me.profileID
        if forYou.isEmpty { feedState = .loading }

        async let feed = api.feed()
        async let followingTakes = api.followingFeed()
        async let saves = api.saved()
        async let people = api.following(of: myID)
        async let fans = api.followers(of: myID)
        async let mine = api.takes(by: myID)
        async let profile = api.profileDetail(myID)
        async let cash = api.cash()
        async let owned = api.positions()
        async let suggestions = api.suggested()
        async let posting = fork != nil ? api.postingTakes() : []

        do {
            forYou = try await feed
            feedState = .loaded
        } catch {
            log.error("feed failed: \(error.localizedDescription, privacy: .public)")
            feedState = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't load takes.")
        }
        if let takes = try? await followingTakes { followingFeed = takes }
        if let takes = try? await saves { savedTakes = takes }
        if let list = try? await people {
            followingPeople = list
            following = Set(list.map(\.profileID))
        }
        if let list = try? await fans { followers = list }
        if let list = try? await suggestions { suggested = list }
        if let takes = try? await mine { myTakes = takes }
        if fork != nil { await reconcilePosting((try? await posting) ?? myTakes.filter(\.posting)) }
        if let detail = try? await profile {
            me = detail.person
            privacy = detail.privacy
        }
        if fork != nil {
            await refreshCash()
            return
        }
        do {
            apply(try await cash)
        } catch {
            log.error("cash failed: \(error.localizedDescription, privacy: .public)")
        }
        if let owned = try? await owned { positions = owned }
    }

    // MARK: Cash

    /// Adds money. Simulated until a payments provider exists: the server
    /// records it, with the same limits the real thing will have.
    func deposit(_ amount: Double, method: FundingMethod) async throws {
        if let fork {
            apply(try await fork.deposit(amount))
            for range in portfolioHistory.keys { await refreshHistory(range) }
        } else if let api {
            apply(try await api.deposit(amount, method: method))
        } else {
            balance += amount
            cashActivity.insert(CashEntry(id: UUID().uuidString, kind: .deposit, amount: amount, method: method,
                                          date: .now, takeClaim: nil), at: 0)
        }
    }

    /// Sends money out of your balance. Simulated payout for now.
    func withdraw(_ amount: Double, method: FundingMethod) async throws {
        if fork != nil {
            // Play money stays on the fork; Cash hides Withdraw in fork mode.
            throw ForkAPIError(code: "withdrawals_off", message: "Play money can't be withdrawn.")
        } else if let api {
            apply(try await api.withdraw(amount, method: method))
        } else {
            guard amount <= balance else { throw SocialAPIError.invalid("insufficient_funds") }
            balance -= amount
            cashActivity.insert(CashEntry(id: UUID().uuidString, kind: .withdrawal, amount: -amount, method: method,
                                          date: .now, takeClaim: nil), at: 0)
        }
    }

    /// Trades or fades a take for `amount`: buys shares at the take's price
    /// (into your position on that side), and the take's counts go up.
    func trade(_ take: Take, side: Side, amount: Double) async throws {
        if let fork {
            guard amount >= minTrade else { throw SocialAPIError.invalid("below_minimum") }
            try await fork.trade(take.id, side: side, amount: amount)
            // The trade has landed: the sheet closes now, and cash, the receipt and the portfolio
            // catch up in the background (they used to add several seconds before it closed).
            Task { await refreshAfterTrade(take.id) }
        } else if let api {
            let (cash, updated) = try await api.trade(take.id, side: side, amount: amount)
            apply(cash)
            updateTake(take.id) { $0 = updated }
            // The new trade joins (or adds to) a position.
            if let owned = try? await api.positions() { positions = owned }
        } else {
            guard amount >= Self.minTrade else { throw SocialAPIError.invalid("below_minimum") }
            guard amount <= balance else { throw SocialAPIError.invalid("insufficient_funds") }
            balance -= amount
            cashActivity.insert(CashEntry(id: UUID().uuidString, kind: side == .back ? .trade : .fade, amount: -amount,
                                          method: nil, date: .now, takeClaim: take.claim), at: 0)
            updateTake(take.id) {
                if side == .back { $0.backs += 1 } else { $0.fades += 1 }
                $0.moneyIn += amount
            }
            addMockShares(take, side: side, amount: amount)
        }
    }

    /// After a fork trade: the take's receipt and your cash first (what the screen shows), then the
    /// portfolio, its chart and creator fees.
    private func refreshAfterTrade(_ takeID: String) async {
        guard let fork else { return }
        async let cash: Void = refreshCash()
        if let receipt = try? await fork.receipt(takeID) { applyReceipt(receipt, to: takeID) }
        await cash
        await refreshPortfolio()
    }

    func quoteForkExit(_ take: Take, position: String) async throws -> ForkBuild {
        guard let fork else { throw SocialAPIError.invalid("fork_unavailable") }
        return try await fork.quoteExit(take.id, position: position)
    }

    func confirmForkExit(_ quote: ForkBuild) async throws {
        guard let fork else { throw SocialAPIError.invalid("fork_unavailable") }
        _ = try await fork.signAndSubmit(quote)
        // A sale with Phoenix legs closed them; their cash comes back to USDC in a second step.
        // If that fails, it waits on the Cash screen ("Cash out").
        if quote.phoenixCashOut == true {
            do { try await fork.cashOutPhoenix() } catch {
                log.error("phoenix cash-out failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        await refreshCash()
        await refreshPortfolio()
    }

    /// Moves cash left on Phoenix back to your balance (closing positions left open first).
    func cashOutPhoenix() async throws {
        guard let fork else { return }
        try await fork.cashOutPhoenix()
        await refreshCash()
        await refreshPortfolio()
    }

    /// Your position on this take and side, if you hold one.
    func position(in take: Take, side: Side) -> OwnedPosition? {
        positions.first { $0.take.id == take.id && $0.side == side }
    }

    /// Sells `amount` dollars of a position at today's price, or all of it when
    /// nil. The money goes back into your balance.
    @discardableResult
    func sell(_ position: OwnedPosition, amount: Double?) async throws -> SaleResult {
        if let api {
            let (cash, result) = try await api.sell(position.take.id, side: position.side, amount: amount)
            apply(cash)
            if let owned = try? await api.positions() { positions = owned }
            return result
        }
        guard let i = positions.firstIndex(where: { $0.id == position.id }) else {
            throw SocialAPIError.invalid("no_position")
        }
        var p = positions[i]
        let worth = (p.value * 100).rounded() / 100
        let result: SaleResult
        if let amount, amount < worth {
            guard amount >= Self.minTrade else { throw SocialAPIError.invalid("below_minimum") }
            let keep = 1 - amount / p.value
            let costSold = p.amount * (1 - keep)
            p.shares *= keep
            p.amount *= keep
            p.value *= keep
            p.lastAt = .now
            positions[i] = p
            result = SaleResult(sold: amount, pnl: amount - costSold, closed: false)
        } else {
            positions.remove(at: i)
            result = SaleResult(sold: worth, pnl: worth - p.amount, closed: true)
        }
        if result.sold > 0 {
            balance += result.sold
            cashActivity.insert(CashEntry(id: UUID().uuidString, kind: .sell, amount: result.sold, method: nil,
                                          date: .now, takeClaim: p.take.claim), at: 0)
        }
        return result
    }

    /// Mock mode: a trade buys shares at the take's price.
    private func addMockShares(_ take: Take, side: Side, amount: Double) {
        let price = take.price
        guard price > 0 else { return }
        if let i = positions.firstIndex(where: { $0.take.id == take.id && $0.side == side }) {
            var p = positions.remove(at: i)
            p.shares += amount / price
            p.amount += amount
            p.price = price
            p.value = OwnedPosition.value(side: side, shares: p.shares, cost: p.amount, price: price)
            p.count += 1
            p.lastAt = .now
            positions.insert(p, at: 0)
        } else {
            positions.insert(OwnedPosition(take: take, side: side, amount: amount, shares: amount / price, price: price,
                                           value: amount, count: 1, lastAt: .now), at: 0)
        }
    }

    /// Signed in, what you've made (profile score, drawer) is the gain or loss on what you hold:
    /// on the fork, the chain's cost and value of each priced position; otherwise the paper
    /// positions at today's price. Sold positions aren't counted yet.
    private func updateMyReturn() {
        // On the fork, "made" is the chain's: scored P&L of settled positions, from your profile
        // (person_json with the network header). Open positions don't count toward it.
        guard isLive, !isOnFork else { return }
        var cost = 0.0, value = 0.0
        for p in positions { cost += p.amount; value += p.value }
        let made = value - cost
        me = Person(id: me.id, name: me.name, made: made, returnPct: cost > 0 ? made / cost * 100 : 0,
                    takes: me.takes, bio: me.bio, remoteID: me.remoteID, avatarURL: me.avatarURL)
    }

    /// Reloads just your balance and activity.
    func refreshCash() async {
        if let fork {
            do {
                apply(try await fork.summary())
            } catch {
                log.error("fork wallet failed: \(error.localizedDescription, privacy: .public)")
            }
            phoenixCash = try? await fork.phoenixCash()
            return
        }
        guard let api, let cash = try? await api.cash() else { return }
        apply(cash)
    }

    // MARK: Fork mode

    /// Reloads your fork positions and badges (profile page, and after a trade).
    func refreshPortfolio() async {
        guard let fork else { return }
        do {
            forkPortfolio = try await fork.portfolio()
        } catch {
            log.error("fork portfolio failed: \(error.localizedDescription, privacy: .public)")
        }
        for range in portfolioHistory.keys { await refreshHistory(range) }
        await refreshCreatorFees()
    }

    func refreshCreatorFees() async {
        guard let fork else { return }
        do {
            creatorFees = try await fork.creatorFees()
        } catch {
            log.error("creator fees failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Claims your creator fees on one take (its on-chain address), or on all of them.
    func claimCreatorFees(take: String?) async throws {
        guard let fork else { return }
        try await fork.claimCreatorFees(takes: take.map { [$0] })
        await refreshCreatorFees()
        await refreshCash()
        // The claimed USDC moves the profile's total: reload the chart too.
        for range in portfolioHistory.keys { await refreshHistory(range) }
    }

    /// Reloads your portfolio chart for one range (fork mode).
    func refreshHistory(_ range: String) async {
        guard let fork else { return }
        do {
            portfolioHistory[range] = try await fork.history(range.uppercased())
        } catch {
            log.error("fork history failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: Notifications

    /// Reloads your inbox, and raises a local notification for each unread one newer than any
    /// raised before (Background App Refresh calls this too). The first load only marks the
    /// newest, so a fresh install doesn't replay old notifications.
    func refreshNotifications() async {
        guard let api, let inbox = try? await api.notifications() else { return }
        notifications = inbox.notifications
        unreadNotifications = inbox.unread
        await LocalNotifier.raise(inbox.notifications.filter { !$0.read })
    }

    /// Marks everything read (opening the inbox).
    func markNotificationsRead() async {
        guard let api, unreadNotifications > 0 else { return }
        guard let unread = try? await api.markNotificationsRead() else { return }
        unreadNotifications = unread
        notifications = notifications.map { n in
            AppNotification(id: n.id, kind: n.kind, title: n.title, body: n.body, takeId: n.takeId, createdAt: n.createdAt, read: true, data: n.data)
        }
    }

    /// A loaded take by id (feeds, saved, yours), so a profile row can open its page.
    func loadedTake(_ id: String) -> Take? {
        (myTakes + forYou + followingFeed + savedTakes).first { $0.id == id }
    }

    func notificationTake(_ id: String) async -> Take? {
        if let take = loadedTake(id) { return take }
        return try? await api?.take(id: id)
    }

    /// A take's on-chain receipt (fork mode only).
    func receipt(for take: Take) async -> ForkReceipt? {
        guard let fork else { return nil }
        do {
            let receipt = try await fork.receipt(take.id)
            applyReceipt(receipt, to: take.id)
            return receipt
        } catch {
            log.error("receipt failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// On the fork the chain is the source of truth for counts and money in.
    private func applyReceipt(_ r: ForkReceipt, to id: String) {
        guard r.onChain, let backers = r.backers else { return }
        updateTake(id) {
            $0.backs = backers
            $0.fades = r.faders ?? 0
            $0.moneyIn = (r.totalBackedUsd ?? 0) + (r.totalFadedUsd ?? 0)
        }
    }

    /// Wallet balance and activity, as Cash shows them. Fork deposits and withdrawals have no
    /// funding method; trades show the take's claim when it's loaded.
    private func apply(_ s: ForkWalletSummary) {
        balance = s.usdc
        let claims = Dictionary((forYou + followingFeed + savedTakes + myTakes).map { ($0.id, $0.claim) }, uniquingKeysWith: { a, _ in a })
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        cashActivity = s.activity.enumerated().compactMap { i, a in
            guard let kind = CashEntry.Kind(rawValue: a.kind == "back" ? "trade" : a.kind),
                  let date = iso.date(from: a.at) ?? ISO8601DateFormatter().date(from: a.at) else { return nil }
            let signed = kind == .deposit ? a.usd : -a.usd
            return CashEntry(id: a.signature ?? "\(a.kind)-\(a.at)-\(i)", kind: kind, amount: signed, method: nil,
                             date: date, takeClaim: a.takeId.flatMap { claims[$0] })
        }
        cashHasMore = false
    }

    /// Loads the next page of older activity (Cash calls this at the bottom of the list).
    func loadMoreCash() async {
        guard let api, cashHasMore, !loadingMoreCash, let last = cashActivity.last else { return }
        loadingMoreCash = true
        defer { loadingMoreCash = false }
        do {
            let page = try await api.activity(after: last)
            let known = Set(cashActivity.map(\.id))
            cashActivity += page.entries.filter { !known.contains($0.id) }
            cashHasMore = page.hasMore
        } catch {
            log.error("older activity failed: \(error.localizedDescription, privacy: .public)")
            actionError = (error as? LocalizedError)?.errorDescription ?? "Couldn't load older activity."
        }
    }

    /// Replaces the balance and the newest page. Older pages are dropped and load
    /// again as you scroll, so the list always matches the server.
    private func apply(_ cash: CashSummary) {
        balance = cash.balance
        cashActivity = cash.activity
        cashHasMore = cash.hasMore
    }

    /// Changes a take everywhere it's shown.
    private func updateTake(_ id: String, _ change: (inout Take) -> Void) {
        for i in forYou.indices where forYou[i].id == id { change(&forYou[i]) }
        for i in followingFeed.indices where followingFeed[i].id == id { change(&followingFeed[i]) }
        for i in savedTakes.indices where savedTakes[i].id == id { change(&savedTakes[i]) }
        for i in myTakes.indices where myTakes[i].id == id { change(&myTakes[i]) }
    }

    // MARK: Saves

    func isSaved(_ take: Take) -> Bool { savedTakes.contains { $0.id == take.id } }

    func toggleSave(_ take: Take) {
        let on = !isSaved(take)
        let before = savedTakes
        if on { savedTakes.insert(take, at: 0) } else { savedTakes.removeAll { $0.id == take.id } }
        send("save", undo: { self.savedTakes = before }) { try await $0.setSaved(take.id, on) }
    }

    // MARK: Follows

    func isFollowing(_ person: Person) -> Bool { following.contains(person.profileID) }
    func isMe(_ person: Person) -> Bool { person.profileID == me.profileID }

    /// Someone's profile: fresh counts and their takes (mock data offline).
    func personDetail(_ person: Person) async -> PersonDetail {
        guard let api, let id = person.remoteID else {
            let takes = MockData.allTakes.filter { $0.author.id == person.id }
            return PersonDetail(person: person, followers: 120 + person.takes * 7,
                                following: 80 + person.takes * 3, takes: takes)
        }
        async let profile = api.profileDetail(id)
        async let takes = api.takes(by: id)
        let found = try? await profile
        return PersonDetail(person: found?.person ?? person,
                            followers: found?.followers ?? 0, following: found?.following ?? 0,
                            takes: (try? await takes) ?? [], privacy: found?.privacy ?? FollowPrivacy())
    }

    /// Someone's followers / following, unless they keep it private (mock lists offline).
    func peopleList(of person: Person, _ tab: ConnectionsTab) async -> PeopleList {
        guard let api, let id = person.remoteID else {
            return .people(tab == .followers ? Array(MockData.everyone.prefix(4)) : Array(MockData.everyone.suffix(3)))
        }
        do {
            return .people(try await tab == .followers ? api.followers(of: id) : api.following(of: id))
        } catch SocialAPIError.hidden {
            return .hidden
        } catch {
            return .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't load this list.")
        }
    }

    // MARK: Privacy

    /// Turns showing your following / followers on or off (saved right away).
    func setPrivacy(_ new: FollowPrivacy) {
        let before = privacy
        privacy = new
        guard isLive else { return }
        send("privacy", undo: { self.privacy = before }) { api in
            self.privacy = try await api.updatePrivacy(new)
        }
    }

    /// Removes someone from your followers.
    func removeFollower(_ person: Person) {
        let before = followers
        followers.removeAll { $0.profileID == person.profileID }
        guard isLive else { return }
        send("remove follower", undo: { self.followers = before }) { api in
            try await api.removeFollower(person.profileID)
        }
    }

    /// Wakes the take builder while you write, so Build doesn't wait on a cold start.
    /// At most once a minute; fire-and-forget.
    func warmTakeBuilder() {
        guard let api, Date().timeIntervalSince(lastWarm) > 60 else { return }
        lastWarm = Date()
        Task.detached(priority: .utility) { await api.warmTakeBuilder() }
    }
    @ObservationIgnored private var lastWarm = Date.distantPast

    /// Builds the basket for a draft (take-builder). Offline: the mock basket.
    func buildBasket(for draft: TakeDraft) async throws -> BuiltBasket {
        await waitForSession()
        guard let api else {
            var legs = MockData.basket(for: draft.risk)
            if let seed = draft.seed, !legs.contains(where: { $0.assetKey == seed.key }) {
                legs = BasketMath.adding(seed, to: legs)
            }
            return BuiltBasket(legs: legs, summary: nil, noExposureReason: nil)
        }
        return try await api.buildBasket(claim: draft.claim, risk: draft.risk, horizon: draft.horizon,
                                         include: draft.seed.map { [$0.id] } ?? [])
    }

    /// Changes the draft's basket the way `ask` says ("add AMD", "less crypto"). Offline: "add X" /
    /// "remove X" against the mock assets.
    func editBasket(_ draft: TakeDraft, legs: [Leg], ask: String) async throws -> BuiltBasket {
        guard let api else { return MockData.edit(legs, ask: ask) }
        return try await api.editBasket(claim: draft.claim, risk: draft.risk, horizon: draft.horizon, legs: legs, ask: ask)
    }

    /// The same picks at the draft's (new) risk: only the cash or leveraged pick changes.
    func adjustRisk(_ draft: TakeDraft, legs: [Leg]) async throws -> BuiltBasket {
        guard let api else { return BuiltBasket(legs: MockData.adjust(legs, risk: draft.risk), summary: nil, noExposureReason: nil) }
        return try await api.adjustBasketRisk(claim: draft.claim, risk: draft.risk, horizon: draft.horizon, legs: legs)
    }

    // MARK: Assets

    /// Assets matching a ticker, name or idea; empty = the most traded.
    /// Recent asset searches (a minute each), so retyping, backspacing or reopening "Add a pick"
    /// shows results at once.
    @ObservationIgnored private var assetSearches: [String: (at: Date, assets: [Asset])] = [:]

    func searchAssets(_ query: String) async throws -> [Asset] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let api else { return MockData.searchAssets(q) }
        if let hit = assetSearches[q], Date().timeIntervalSince(hit.at) < 60 { return hit.assets }
        let found = try await api.searchAssets(q)
        if assetSearches.count > 200 { assetSearches.removeAll() }
        assetSearches[q] = (Date(), found)
        return found
    }

    func assetPage(_ id: String, range: AssetRange) async throws -> AssetPage {
        guard let api else {
            guard let page = MockData.assetPage(id, range: range) else { throw SocialAPIError.notFound }
            return page
        }
        return try await api.assetPage(id, range: range)
    }

    /// Takes holding an asset, newest first.
    func takes(holding assetID: String) async -> [Take] {
        guard let api else {
            let key = MockData.assets.first { $0.id == assetID }?.key
            return (MockData.trending + MockData.feed).filter { $0.legs.contains { $0.assetKey == key } }
        }
        return (try? await api.assetTakes(assetID)) ?? []
    }

    /// People by handle or name.
    func searchPeople(_ query: String) async throws -> [Person] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "@"))
        guard !q.isEmpty else { return [] }
        guard let api else {
            return MockData.everyone.filter { $0.id.localizedCaseInsensitiveContains(q) || $0.name.localizedCaseInsensitiveContains(q) }
        }
        return try await api.searchPeople(q).filter { !isMe($0) }
    }

    /// Opens the composer with this asset already in the basket.
    func startTake(with asset: Asset) {
        drawerOpen = false
        seededTake = asset
    }

    /// Who traded / faded a take (mock data offline).
    func traders(for take: Take) async -> [Trader] {
        guard let api else {
            return [Trader(person: MockData.me, side: .back, amount: 20, isYou: true),
                    Trader(person: MockData.priya, side: .back, amount: 40, isYou: false),
                    Trader(person: MockData.lena, side: .back, amount: 20, isYou: false),
                    Trader(person: MockData.dev, side: .fade, amount: 20, isYou: false)]
        }
        return (try? await api.traders(of: take.id)) ?? []
    }

    /// Hides a suggestion until the next refresh.
    func dismissSuggestion(_ suggestion: Suggestion) {
        suggested.removeAll { $0.id == suggestion.id }
    }

    func toggleFollow(_ person: Person) {
        guard !isMe(person) else { return }
        let on = !isFollowing(person)
        let before = (following, followingPeople, followingFeed)
        if on {
            following.insert(person.profileID)
            if !followingPeople.contains(where: { $0.profileID == person.profileID }) {
                followingPeople.insert(person, at: 0)
            }
        } else {
            following.remove(person.profileID)
            followingPeople.removeAll { $0.profileID == person.profileID }
            followingFeed.removeAll { $0.author.profileID == person.profileID }
        }
        guard isLive else {
            followingFeed = mockFollowingFeed()
            return
        }
        send("follow", undo: { (self.following, self.followingPeople, self.followingFeed) = before }) { api in
            try await api.setFollowing(person.profileID, on)
            let feed = try await api.followingFeed()
            self.followingFeed = feed
        }
    }

    private func mockFollowingFeed() -> [Take] {
        MockData.followingFeed.filter { following.contains($0.author.profileID) }
    }

    // MARK: Takes

    /// Posts a take and puts it at the top of For you.
    /// `confirmLeftOut`: asked before signing when the buy-in would leave legs out (fork mode); no
    /// means nothing is signed, the posting take is discarded, and this throws `post_cancelled`.
    func post(_ draft: TakeDraft, legs: [Leg], confirmLeftOut: (([ForkBuild.LeftOut]) async -> Bool)? = nil) async throws {
        if let fork {
            guard draft.buyIn.isFinite, draft.buyIn >= minTrade else {
                throw ForkAPIError(code: "invalid_amount", message: "The minimum buy-in is \(Fmt.usd(minTrade)).")
            }
            let wallet = try await fork.summary()
            await loadForkConfig()
            // The program checks it too; this just says so before the post.
            guard draft.buyIn * (1 + (forkFeeRate ?? 0)) <= wallet.usdc else {
                throw ForkAPIError(code: "insufficient_funds", message: nil)
            }
        }
        var take: Take
        if let api {
            take = try await api.post(NewTake(draft: draft, legs: legs, awaitChain: fork != nil))
            // Credit where it came from. Not worth failing the post over: it just shows without it.
            if let source = draft.source {
                do {
                    try await api.attachSource(take.id, source)
                    take.source = source
                } catch {
                    log.error("attach source failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        } else {
            take = Take(id: UUID().uuidString, author: me, claim: draft.claim.trimmingCharacters(in: .whitespacesAndNewlines),
                        topic: TopicGuess(claim: draft.claim, legs: legs).topic, risk: draft.risk,
                        horizon: draft.horizon.serverValue, age: "now", since: Date.now.formatted(.dateTime.month(.abbreviated).day()),
                        settles: "", ret: 0, legs: legs, backs: 0, fades: 0, comments: 0, moneyIn: 0,
                        history: [0, 0], tags: [])
        }
        forYou.insert(take, at: 0)
        myTakes.insert(take, at: 0)
        // Fork mode: buying in is required to post. The take stays "posting…" (yours only) until
        // its on-chain buy-in confirms; if that fails it shows "Didn't post" with Retry / Discard,
        // so a failure here is shown on the take, not thrown.
        if fork != nil, take.posting {
            PostingBuyIns.set(draft.buyIn, for: take.id)
            // The composer closes once the buy-in is sent; going live is watched from the feed.
            do {
                if try await sendBuyIn(take.id, confirm: confirmLeftOut) { Task { await self.waitUntilLive(take.id) } }
            } catch {
                // You chose not to post with legs left out: nothing was signed, so the take goes,
                // and the composer stays open on your basket.
                await discardPost(take)
                throw error
            }
        }
    }

    /// A link that cold-starts the app (the share sheet, a chat link, a tapped notification) gets
    /// here while sign-in is still finishing: wait for it, rather than answer from the offline
    /// demo data. Returns at once offline (UI tests, previews) or after 10 s.
    func waitForSession() async {
        guard api == nil, !LaunchFlags.skipsAuth else { return }
        for _ in 0..<40 where api == nil {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    // MARK: Takes from what you read

    /// Reads a shared article or X post and fills the draft with the take drafted from it. If it
    /// can't be read, the draft stays empty for you to write, still credited to the link.
    func draftTake(from request: TakeLink.ReadRequest, keeping draft: TakeDraft) async -> TakeDraft {
        await waitForSession()
        var out = draft
        let fallback = TakeSource(url: request.url, label: String((request.url.host() ?? "link").replacingOccurrences(of: "www.", with: "").prefix(60)), kind: "link")
        guard let api else {
            try? await Task.sleep(for: .seconds(2))
            out.claim = request.title.map { String($0.prefix(140)) } ?? "AI power demand is underrated."
            out.source = fallback
            return out
        }
        do {
            let d = try await api.draftTake(from: request)
            out.claim = d.claim
            out.risk = Risk.allCases.first { $0.rawValue.lowercased() == d.risk } ?? out.risk
            out.horizon = Horizon.allCases.first { $0.long == d.horizon } ?? out.horizon
            out.source = d.takeSource
        } catch {
            log.error("draft from source failed: \(error.localizedDescription, privacy: .public)")
            out.claim = request.title.map { String($0.prefix(140)) } ?? ""
            out.source = fallback
        }
        return out
    }

    // MARK: Copying X accounts

    /// The X accounts you copy, with their recent calls.
    private(set) var xAccounts: [XAccount] = []

    func refreshXAccounts() async {
        guard let api else {
            xAccounts = MockData.xAccounts
            return
        }
        do { xAccounts = try await api.xAccounts() } catch {
            log.error("x accounts failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Starts copying an account. Throws a readable error ("No recent posts from @…").
    func copyX(_ handle: String) async throws {
        guard let api else {
            try? await Task.sleep(for: .seconds(1))
            if !xAccounts.contains(where: { $0.handle == handle.lowercased() }) {
                xAccounts.insert(XAccount(handle: handle.lowercased(), username: handle, name: handle, avatarUrl: nil, calls: MockData.xAccounts.first?.calls ?? []), at: 0)
            }
            return
        }
        do {
            let account = try await api.copyX(handle)
            xAccounts.removeAll { $0.handle == account.handle }
            xAccounts.insert(account, at: 0)
        } catch let error as SocialAPIError {
            throw CopyXError(error, handle: handle)
        }
    }

    func stopCopyingX(_ account: XAccount) async {
        let before = xAccounts
        xAccounts.removeAll { $0.handle == account.handle }
        guard let api else { return }
        do { try await api.stopCopyingX(account.handle) } catch { xAccounts = before }
    }

    // MARK: Posting (fork mode)

    enum PostState: Equatable {
        /// Sent (or being sent); waiting for the chain.
        case posting
        /// Not on-chain: Retry or Discard.
        case failed(String)
        /// On-chain, but the backend hasn't seen it yet: Check again.
        case unconfirmed
    }

    /// How long "posting…" may last before the take shows as not posted.
    static let postingTimeout: TimeInterval = 120

    /// Signs and sends the take's buy-in, then waits for the chain to make it live.
    private func publishPosting(_ id: String) async {
        if (try? await sendBuyIn(id)) == true { await waitUntilLive(id) }
    }

    /// Signs and sends the take's buy-in. False (and "Didn't post") if it can't have landed.
    /// Throws only `post_cancelled` (you said no to legs being left out); other failures show on the take.
    private func sendBuyIn(_ id: String, confirm: (([ForkBuild.LeftOut]) async -> Bool)? = nil) async throws -> Bool {
        guard let fork else { return false }
        postStates[id] = .posting
        let amount = PostingBuyIns.get(id) ?? minTrade
        do {
            try await fork.publish(id, amount: amount, confirm: confirm)
            await refreshCash()
        } catch let e as ForkAPIError where e.code == "post_cancelled" {
            throw e
        } catch let e as ForkAPIError where e.code == "already_on_chain" || e.code == "already_live" {
            // An earlier send landed: wait for it below.
        } catch {
            log.error("fork publish failed: \(error.localizedDescription, privacy: .public)")
            // The send may have landed even though the answer didn't come back.
            if (try? await fork.confirmPublish(id))?.onChain != true {
                postStates[id] = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't send your buy-in.")
                return false
            }
        }
        return true
    }

    /// Polls the public read until the take is live (the chain event made it so). Halfway, asks
    /// the fork API to deliver the publish again; at the timeout, says whether it's on-chain.
    private func waitUntilLive(_ id: String) async {
        guard let api, let fork else { return }
        postStates[id] = .posting
        let start = Date.now
        var nudged = false
        while Date.now.timeIntervalSince(start) < Self.postingTimeout {
            if let live = try? await api.take(id: id), !live.posting {
                wentLive(live)
                return
            }
            if !nudged, Date.now.timeIntervalSince(start) > Self.postingTimeout / 2 {
                nudged = true
                _ = try? await fork.confirmPublish(id)
            }
            try? await Task.sleep(for: .seconds(2))
        }
        if let live = try? await api.take(id: id), !live.posting {
            wentLive(live)
        } else if (try? await fork.confirmPublish(id))?.onChain == true {
            postStates[id] = .unconfirmed
        } else {
            postStates[id] = .failed("Your buy-in didn't go through.")
        }
    }

    private func wentLive(_ take: Take) {
        postStates[take.id] = nil
        PostingBuyIns.set(nil, for: take.id)
        updateTake(take.id) { $0 = take }
    }

    /// Your posting takes from the server (after a relaunch, say): keeps them at the top of your
    /// lists and finds out where each one stands.
    private func reconcilePosting(_ posting: [Take]) async {
        let ids = Set(posting.map(\.id))
        for id in postStates.keys where !ids.contains(id) && postStates[id] != .posting { postStates[id] = nil }
        forYou = posting + forYou.filter { !ids.contains($0.id) }
        myTakes = posting + myTakes.filter { !ids.contains($0.id) }
        for take in posting where postStates[take.id] == nil {
            postStates[take.id] = .posting
            Task { await self.checkPosting(take.id) }
        }
    }

    /// On-chain already: wait for it to go live. Otherwise it didn't post.
    private func checkPosting(_ id: String) async {
        guard let fork else { return }
        if (try? await fork.confirmPublish(id))?.onChain == true {
            await waitUntilLive(id)
        } else {
            postStates[id] = .failed("Your buy-in didn't go through.")
        }
    }

    /// Sends the buy-in again (same amount; nothing else changes). Checks again if it's on-chain.
    func retryPost(_ take: Take) {
        guard postStates[take.id] != .posting else { return }
        Task {
            if postStates[take.id] == .unconfirmed {
                await checkPosting(take.id)
            } else {
                await publishPosting(take.id)
            }
        }
    }

    /// Deletes a take that never made it on-chain.
    func discardPost(_ take: Take) async {
        guard let api, let fork else { return }
        if (try? await fork.confirmPublish(take.id))?.onChain == true {
            // It landed after all: it'll go live.
            await waitUntilLive(take.id)
            return
        }
        do {
            try await api.discard(take.id)
        } catch {
            actionError = "Couldn't discard it. Try again."
            return
        }
        postStates[take.id] = nil
        PostingBuyIns.set(nil, for: take.id)
        forYou.removeAll { $0.id == take.id }
        myTakes.removeAll { $0.id == take.id }
    }

    // MARK: Comments

    func comments(on take: Take) async throws -> [Comment] {
        guard let api else { return MockData.comments }
        return try await api.comments(on: take.id, viewer: me.profileID)
    }

    /// Posts a comment (or a reply) and returns the take's updated thread.
    func comment(on take: Take, text: String, replyingTo parent: Comment?) async throws -> [Comment] {
        guard let api else {
            let mine = Comment(id: UUID().uuidString, author: me, position: nil, age: "now", minutesAgo: 0, likes: 0, text: text)
            return MockData.comments + [mine]
        }
        let thread = try await api.comment(on: take.id, text: text, replyingTo: parent?.id)
        let count = thread.reduce(0) { $0 + 1 + $1.replies.count }
        updateTake(take.id) { $0.comments = count }
        return thread
    }

    func setLiked(_ comment: Comment, _ on: Bool) async throws {
        try await api?.setLiked(comment.id, on)
    }

    // MARK: Profile
    // Name, handle and photo live on the session profile (SessionStore) and reach
    // `me` through `updateMe(from:)`. The bio is the social layer's.

    /// Saves your bio (an empty one clears it).
    func saveBio(_ bio: String) async throws {
        guard let api else {
            me.bio = bio
            return
        }
        let updated = try await api.updateBio(bio)
        me.bio = updated.bio
    }

    /// Mock mode only: there's no session to save name, handle or photo to.
    func editMockProfile(name: String, handle: String, bio: String, avatar: AvatarSelection) {
        guard !isLive else { return }
        var avatarURL = me.avatarURL
        switch avatar {
        case .face(let face, let color): avatarURL = AvatarFace.encode(face, color: color)
        case .photo(let jpeg):
            let url = FileManager.default.temporaryDirectory.appending(path: "avatar-\(UUID().uuidString).jpg")
            if (try? jpeg.write(to: url)) != nil { avatarURL = url.absoluteString }
        case .unchanged: break
        }
        me = Person(id: handle, name: name, made: me.made, returnPct: me.returnPct, takes: me.takes,
                    bio: bio, remoteID: me.remoteID, avatarURL: avatarURL,
                    backersMade: me.backersMade, backersPct: me.backersPct)
    }

    /// Your takes and comments carry your name and photo: reload after an edit.
    func profileChanged() {
        guard isLive else { return }
        Task { await refresh() }
    }

    // MARK: Search and Scores

    /// Matching takes, or trending ones for an empty query. `tag` nil = all topics.
    func search(_ query: String, tag: String?) async throws -> [Take] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api else {
            return MockData.trending.filter { take in
                (tag == nil || take.tags.contains(tag!)) &&
                (q.isEmpty
                 || take.claim.localizedCaseInsensitiveContains(q)
                 || take.author.id.localizedCaseInsensitiveContains(q)
                 || take.legs.contains { $0.name.localizedCaseInsensitiveContains(q) })
            }
        }
        return q.isEmpty ? try await api.trending(tag: tag) : try await api.search(q, tag: tag)
    }

    /// `period`: "Week", "Month" or "All time".
    /// `board`: whose money each row counts. `byPct`: ranked by percent instead of dollars.
    func leaderboard(_ period: String, board: ScoreBoard = .own, byPct: Bool = false) async throws -> [LeaderRow] {
        guard let api else { return MockData.leaderboard(period).rows }
        let key = switch period {
        case "Month": "month"
        case "All time": "all"
        default: "week"
        }
        return try await api.leaderboard(key, board: board.rawValue, sort: byPct ? "pct" : "cash")
    }

    // MARK: Navigation helpers

    /// Close the sidebar and push a screen on Home.
    func open(_ route: PeopleRoute) {
        drawerOpen = false
        tab = .home
        homePath.append(route)
    }

    /// Close the sidebar (if open) and open Add cash.
    func addCash() {
        drawerOpen = false
        showAddCash = true
    }

    /// Close the sidebar (if open) and open Withdraw.
    func startWithdraw() {
        drawerOpen = false
        showWithdraw = true
    }

    /// Close the sidebar (if open) and open Cash (balance + activity) as a sheet.
    func openCash() {
        drawerOpen = false
        showCash = true
    }

    /// Close the sidebar and switch tabs.
    func go(to tab: AppTab) {
        drawerOpen = false
        self.tab = tab
    }

    // MARK: Sending

    /// Runs a write in the background; on failure, undoes the optimistic change
    /// and surfaces the error.
    private func send(_ what: String, undo: @escaping () -> Void, _ work: @escaping (SocialAPI) async throws -> Void) {
        guard let api else { return }
        Task {
            do {
                try await work(api)
            } catch {
                log.error("\(what, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                withAnimation(.snappy) { undo() }
                actionError = (error as? LocalizedError)?.errorDescription ?? "Couldn't \(what). Try again."
            }
        }
    }
}

extension View {
    /// Registers the sidebar and person destinations on a NavigationStack.
    func peopleDestinations() -> some View {
        navigationDestination(for: PeopleRoute.self) { route in
            switch route {
            case .saved: SavedView()
            case .connections(let tab): ConnectionsView(initialTab: tab)
            case .person(let person): PersonProfileView(person: person)
            case .personConnections(let person, let tab): ConnectionsView(owner: person, initialTab: tab)
            case .settings: SettingsView()
            case .asset(let id): AssetView(assetID: id)
            }
        }
    }
}

/// The buy-in each posting take was posted with, so Retry (even after a relaunch) sends the same
/// amount. The server doesn't keep it: the chain does, once the take is on-chain.
enum PostingBuyIns {
    private static let key = "postingBuyIns"

    static func get(_ id: String) -> Double? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: Double])?[id]
    }

    static func set(_ amount: Double?, for id: String) {
        var all = (UserDefaults.standard.dictionary(forKey: key) as? [String: Double]) ?? [:]
        all[id] = amount
        UserDefaults.standard.set(all, forKey: key)
    }
}
