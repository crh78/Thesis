import Foundation
import os

/// Fork mode: trades built before the tap, so tapping only signs and sends. A sheet asks for a
/// build as it opens and as its amount changes (`want`), keeps the current one fresh while it's
/// visible (`tick`), and takes one at the tap (`take`): a fresh build made earlier, the one being
/// made, or (when there's none) one built now.
///
/// Keyed by what a build is for: the trade sheet's amount in cents, or a sale's position. A build
/// is used once. Builds stop being refreshed after three minutes without a change, and asking
/// stops for a while if the fork API says it's busy or you're over its limits.
///
/// Building ahead goes on only once a build made ahead answered `prebuilt: true`: the fork API
/// served it as a prebuild, its money action counted at submit (`PrebuildSupport`). An API that
/// answers without it (it ignores `prebuild`, or can't defer the money action) counts every build
/// against the wallet's money limit, so it gets one early build, and the tap builds as before.
@MainActor
final class Prebuilds<Key: Hashable> {
    typealias Build = (_ key: Key, _ prebuild: Bool) async throws -> ForkPrepared

    private let build: Build
    private let refresh: (ForkPrepared) async throws -> ForkPrepared?
    private var ready: [Key: ForkPrepared] = [:]
    private var building: [Key: Task<ForkPrepared?, Never>] = [:]
    /// Builds signed already: one that comes back from a refresh started before is dropped.
    private var used: Set<String> = []
    private var lastActivity = Date.now
    /// The key last asked for: built once the first early build says the API serves prebuilds.
    private var lastWanted: Key?
    private var pausedUntil = Date.distantPast
    private let log = Logger(subsystem: "xyz.yourthesis.app", category: "trade")

    /// No refreshing after this long without a change; the tap builds then.
    static var idleLimit: TimeInterval { 180 }
    /// How long to stop building ahead after the fork API said busy or rate-limited.
    static var pause: TimeInterval { 30 }

    init(build: @escaping Build, refresh: @escaping (ForkPrepared) async throws -> ForkPrepared?) {
        self.build = build
        self.refresh = refresh
    }

    /// A fresh build for `key`, if one is ready.
    func readyBuild(_ key: Key) -> ForkPrepared? {
        ready[key].flatMap { $0.isFresh ? $0 : nil }
    }

    /// Builds `key` ahead of the tap, unless a fresh build is ready or one is being made, or the
    /// fork API doesn't serve prebuilds.
    func want(_ key: Key) {
        lastActivity = .now
        lastWanted = key
        guard PrebuildSupport.served != false, Date.now >= pausedUntil, readyBuild(key) == nil, building[key] == nil else { return }
        // Until the first answer says what this API does, one early build at a time.
        if PrebuildSupport.served == nil, !building.isEmpty { return }
        start(key) { [build] in try await build(key, true) }
    }

    /// The build for `key` once the one asked for is made, left ready for the tap. If making it
    /// failed (or there was none), builds it now, so the caller sees why.
    func made(_ key: Key) async throws -> ForkPrepared {
        if let made = readyBuild(key) { return made }
        if let pending = building[key], let made = await pending.value, made.isFresh, !used.contains(made.build.buildId) {
            return made
        }
        // A prebuild only while the API may serve one (otherwise a normal build, as at the tap).
        let early = PrebuildSupport.served != false
        let made = try await build(key, early)
        if early { PrebuildSupport.note(made.build) }
        ready[key] = made
        return made
    }

    /// The build to sign at the tap, and whether it was made before the tap.
    func take(_ key: Key) async throws -> (ForkPrepared, prebuilt: Bool) {
        lastActivity = .now
        if let made = readyBuild(key) {
            use(key, made)
            return (made, true)
        }
        if let pending = building[key], let made = await pending.value, made.isFresh, !used.contains(made.build.buildId) {
            use(key, made)
            return (made, true)
        }
        let made = try await build(key, false)
        used.insert(made.build.buildId)
        return (made, false)
    }

    /// Run about every second while the sheet is visible: refreshes `key`'s build when it's close
    /// to expiring, and lets builds for other keys go once they're stale.
    func tick(_ key: Key) {
        for (k, made) in ready where k != key && !made.isFresh { ready[k] = nil }
        guard PrebuildSupport.served == true, Date.now.timeIntervalSince(lastActivity) < Self.idleLimit, Date.now >= pausedUntil,
              building[key] == nil, let made = ready[key], made.secondsLeft < ForkPrepared.refreshBelow else { return }
        start(key) { [build, refresh] in
            // A fresh blockhash for the same quote; if the API can't (or the quote is old), a new build.
            if let fresh = try await refresh(made) { return fresh }
            return try await build(key, true)
        }
    }

    /// Forgets every build (the take or your balance changed under them).
    func reset() {
        ready = [:]
        building.values.forEach { $0.cancel() }
        building = [:]
    }

    private func use(_ key: Key, _ made: ForkPrepared) {
        used.insert(made.build.buildId)
        ready[key] = nil
    }

    private func start(_ key: Key, _ work: @escaping () async throws -> ForkPrepared) {
        building[key] = Task { [weak self] in
            do {
                let made = try await work()
                let first = PrebuildSupport.served == nil
                PrebuildSupport.note(made.build)
                guard let self, !Task.isCancelled else { return made }
                self.building[key] = nil
                if !self.used.contains(made.build.buildId) { self.ready[key] = made }
                // The amount changed while the first early build was out (and was skipped then).
                if first, PrebuildSupport.served == true, let next = self.lastWanted, next != key { self.want(next) }
                return made
            } catch {
                guard let self, !Task.isCancelled else { return nil }
                self.building[key] = nil
                self.ready[key] = nil
                if let e = error as? ForkAPIError, ["rate_limited", "busy", "http_429", "http_503"].contains(e.code) {
                    self.pausedUntil = Date.now.addingTimeInterval(Self.pause)
                }
                self.log.info("build ahead failed: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
    }
}

/// Whether this fork API serves `prebuild: true` as a prebuild: nil until a build made ahead
/// answered, then true only if it said `prebuilt: true`. Shared by every sheet for the app's run.
@MainActor
enum PrebuildSupport {
    static var served: Bool?

    /// What a build asked for with `prebuild: true` (or its refresh) says about the API.
    static func note(_ build: ForkBuild) {
        served = build.prebuilt == true
    }
}
